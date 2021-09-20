/*
* format-html.ts
*
* Copyright (C) 2020 by RStudio, PBC
*
*/

import { join } from "path/mod.ts";

import { Document, Element } from "deno_dom/deno-dom-wasm-noinit.ts";

import { renderEjs } from "../../core/ejs.ts";
import { mergeConfigs } from "../../core/config.ts";
import { formatResourcePath } from "../../core/resources.ts";
import { sessionTempFile } from "../../core/temp.ts";
import { asCssSize } from "../../core/css.ts";

import {
  kCodeLink,
  kDoi,
  kFilterParams,
  kHeaderIncludes,
  kIncludeAfterBody,
  kIncludeInHeader,
  kLinkExternalIcon,
  kLinkExternalNewwindow,
} from "../../config/constants.ts";
import {
  DependencyFile,
  Format,
  FormatDependency,
  FormatExtras,
  kDependencies,
  kHtmlPostprocessors,
  kSassBundles,
  PandocFlags,
  SassBundle,
} from "../../config/types.ts";
import { kTheme } from "../../config/constants.ts";

import { formatHasCodeTools } from "../../command/render/codetools.ts";

import { createHtmlFormat } from "./../formats-shared.ts";

import {
  boostrapExtras,
  formatDarkMode,
  formatHasBootstrap,
} from "./format-html-bootstrap.ts";

import {
  clipboardDependency,
  kAnchorSections,
  kBootstrapDependencyName,
  kCodeCopy,
  kComments,
  kDocumentCss,
  kHoverCitations,
  kHoverFootnotes,
  kHypothesis,
  kUtterances,
  quartoDefaults,
  quartoFunctions,
  quartoGlobalCssVariableRules,
  quartoRules,
} from "./format-html-shared.ts";

export function htmlFormat(
  figwidth: number,
  figheight: number,
): Format {
  return mergeConfigs(
    createHtmlFormat(figwidth, figheight),
    {
      formatExtras: (input: string, flags: PandocFlags, format: Format) => {
        const htmlFilterParams = htmlFormatFilterParams(format);
        return mergeConfigs(
          htmlFormatExtras(format),
          themeFormatExtras(input, flags, format),
          { [kFilterParams]: htmlFilterParams },
        );
      },
      extensions: {
        book: {
          multiFile: true,
        },
      },
    },
  );
}

const kFormatHasBootstrap = "has-bootstrap";
function htmlFormatFilterParams(format: Format) {
  return {
    [kFormatHasBootstrap]: formatHasBootstrap(format),
  };
}

export function htmlFormatPostprocessor(format: Format) {
  // do we have haveBootstrap
  const haveBootstrap = formatHasBootstrap(format);

  // read options
  const codeCopy = haveBootstrap
    ? format.metadata[kCodeCopy] !== false
    : format.metadata[kCodeCopy] || false;

  const anchors = haveBootstrap
    ? format.metadata[kAnchorSections] !== false
    : format.metadata[kAnchorSections] || false;

  return (doc: Document): Promise<string[]> => {
    // process all of the code blocks
    const codeBlocks = doc.querySelectorAll("pre.sourceCode");
    for (let i = 0; i < codeBlocks.length; i++) {
      const code = codeBlocks[i] as Element;

      // hoist hidden to parent div
      if (code.classList.contains("hidden")) {
        code.classList.delete("hidden");
        code.parentElement?.classList.add("hidden");
      }

      // insert code copy button
      if (codeCopy) {
        code.classList.add("code-with-copy");
        const copyButton = doc.createElement("button");
        const title = "Copy to Clipboard";
        copyButton.setAttribute("title", title);
        copyButton.classList
          .add("code-copy-button");
        const copyIcon = doc.createElement("i");
        copyIcon.classList.add("bi");
        copyButton.appendChild(copyIcon);

        code.appendChild(copyButton);
      }
    }

    // add .anchored class to headings
    if (anchors) {
      const container = haveBootstrap
        ? doc.querySelector("main")
        : doc.querySelector("body");

      if (container) {
        ["h2", "h3", "h4", "h5", "h6", ".quarto-figure[id]", "div[id^=tbl-]"]
          .forEach(
            (selector) => {
              const headings = container.querySelectorAll(selector);
              for (let i = 0; i < headings.length; i++) {
                const heading = headings[i] as Element;
                if (heading.id !== "toc-title") {
                  if (!heading.classList.contains("no-anchor")) {
                    heading.classList.add("anchored");
                  }
                }
              }
            },
          );
      }
    }

    // remove toc-section-number if we have provided our own section numbers
    const headerSections = doc.querySelectorAll(".header-section-number");
    for (let i = 0; i < headerSections.length; i++) {
      const secNumber = headerSections[i] as Element;
      const prevElement = secNumber.previousElementSibling;
      if (prevElement && prevElement.classList.contains("toc-section-number")) {
        prevElement.remove();
      }
    }

    // add doi to header if provided
    const doi = format.metadata[kDoi];
    if (typeof (doi) === "string") {
      const header = doc.getElementById("title-block-header");
      if (header) {
        const p = doc.createElement("p");
        p.classList.add("doi");
        const doiUrl = `https://doi.org/${doi}`;
        const a = doc.createElement("a");
        a.innerHTML = doiUrl;
        a.setAttribute("href", doiUrl);
        p.appendChild(a);
        header.appendChild(p);
      }
    }

    // no resource refs
    return Promise.resolve([]);
  };
}

function themeFormatExtras(input: string, flags: PandocFlags, format: Format) {
  const theme = format.metadata[kTheme];
  if (theme === "none") {
    return {
      metadata: {
        [kDocumentCss]: false,
      },
    };
  } else if (theme === "pandoc") {
    return pandocExtras(format);
  } else {
    return boostrapExtras(input, flags, format);
  }
}

export const kQuartoHtmlDependency = "quarto-html";
function htmlFormatExtras(format: Format): FormatExtras {
  // lists of scripts and ejs data for the orchestration script

  const scripts: DependencyFile[] = [];
  const stylesheets: DependencyFile[] = [];
  const bootstrap = formatHasBootstrap(format);
  const sassBundles: SassBundle[] = [];
  const dependencies: FormatDependency[] = [];

  const options: Record<string, unknown> = format.metadata[kComments]
    ? {
      [kHypothesis]:
        (format.metadata[kComments] as Record<string, unknown>)[kHypothesis] ||
        false,
      [kUtterances]:
        (format.metadata[kComments] as Record<string, unknown>)[kUtterances] ||
        false,
    }
    : {};
  options.codeLink = format.metadata[kCodeLink] || false;
  if (bootstrap) {
    options.copyCode = format.metadata[kCodeCopy] !== false;
    options.anchors = format.metadata[kAnchorSections] !== false;
    options.hoverCitations = format.metadata[kHoverCitations] !== false;
    options.hoverFootnotes = format.metadata[kHoverFootnotes] !== false;
  } else {
    options.copyCode = format.metadata[kCodeCopy] || false;
    options.anchors = format.metadata[kAnchorSections] || false;
    options.hoverCitations = format.metadata[kHoverCitations] || false;
    options.hoverFootnotes = format.metadata[kHoverFootnotes] || false;
  }
  options.codeTools = formatHasCodeTools(format);
  options.darkMode = formatDarkMode(format);
  options.linkExternalIcon = format.render[kLinkExternalIcon];
  options.linkExternalNewwindow = format.render[kLinkExternalNewwindow];

  // quarto.js helpers
  scripts.push({
    name: "quarto.js",
    path: formatResourcePath("html", join("toc", "quarto-toc.js")),
  });

  // popper if required
  options.tippy = options.hoverCitations || options.hoverFootnotes;
  if (bootstrap || options.tippy) {
    scripts.push({
      name: "popper.min.js",
      path: formatResourcePath("html", join("popper", "popper.min.js")),
    });
  }

  // tippy if required
  if (options.tippy) {
    scripts.push({
      name: "tippy.umd.min.js",
      path: formatResourcePath("html", join("tippy", "tippy.umd.min.js")),
    });
    stylesheets.push({
      name: "tippy.css",
      path: formatResourcePath("html", join("tippy", "tippy.css")),
    });

    // If this is a bootstrap format, include requires sass
    if (bootstrap) {
      options.tippyTheme = "quarto";
      sassBundles.push({
        key: "tippy.scss",
        dependency: kBootstrapDependencyName,
        quarto: {
          functions: "",
          defaults: "",
          mixins: "",
          rules: Deno.readTextFileSync(
            formatResourcePath("html", join("tippy", "_tippy.scss")),
          ),
        },
      });
    } else {
      options.tippyTheme = "light-border";
      stylesheets.push({
        name: "light-border.css",
        path: formatResourcePath("html", join("tippy", "light-border.css")),
      });
    }
  }

  // clipboard.js if required
  if (options.copyCode) {
    dependencies.push(clipboardDependency());
  }

  // anchors if required
  if (options.anchors) {
    scripts.push({
      name: "anchor.min.js",
      path: formatResourcePath("html", join("anchor", "anchor.min.js")),
    });
    options.anchors = typeof (options.anchors) === "string"
      ? options.anchors
      : true;
  }

  // add main orchestion script if we have any options enabled
  const quartoHtmlRequired = Object.keys(options).some((option) =>
    !!options[option]
  );

  if (quartoHtmlRequired) {
    // add quarto sass bundle of we aren't in bootstrap
    if (!bootstrap) {
      sassBundles.push({
        dependency: kQuartoHtmlDependency,
        key: kQuartoHtmlDependency,
        quarto: {
          use: ["sass:color", "sass:math"],
          defaults: quartoDefaults(format),
          functions: quartoFunctions(),
          mixins: "",
          rules: quartoRules(),
        },
      });
    }
  }

  if (!bootstrap) {
    sassBundles.push({
      dependency: kQuartoHtmlDependency,
      key: kQuartoHtmlDependency,
      quarto: {
        defaults: "",
        functions: "",
        mixins: "",
        rules: quartoGlobalCssVariableRules(),
      },
    });
  }

  // header includes
  const includeInHeader: string[] = [];

  // hypothesis
  if (options.hypothesis) {
    const hypothesisHeader = sessionTempFile({ suffix: ".html" });
    Deno.writeTextFileSync(
      hypothesisHeader,
      renderEjs(
        formatResourcePath("html", join("hypothesis", "hypothesis.ejs")),
        { hypothesis: options.hypothesis },
      ),
    );
    includeInHeader.push(hypothesisHeader);
  }

  // after body
  const includeAfterBody: string[] = [];

  // quarto html helpers
  if (quartoHtmlRequired) {
    // html orchestration script
    const quartoHtmlScript = sessionTempFile();
    Deno.writeTextFileSync(
      quartoHtmlScript,
      renderEjs(
        formatResourcePath("html", join("templates", "quarto-html.ejs")),
        options,
      ),
    );
    includeAfterBody.push(quartoHtmlScript);
  }

  // utterances
  if (options.utterances) {
    if (typeof (options.utterances) !== "object") {
      throw new Error("Invalid utterances configuration (must provide a repo");
    }
    const utterances = options.utterances as Record<string, string>;
    if (!utterances["repo"]) {
      throw new Error("Invalid utterances coniguration (must provide a repo)");
    }
    utterances["issue-term"] = utterances["issue-term"] || "pathname";
    utterances["theme"] = utterances["theme"] || "github-light";
    const utterancesAfterBody = sessionTempFile({ suffix: ".html" });
    Deno.writeTextFileSync(
      utterancesAfterBody,
      renderEjs(
        formatResourcePath("html", join("utterances", "utterances.ejs")),
        { utterances },
      ),
    );
    includeAfterBody.push(utterancesAfterBody);
  }

  // return extras
  dependencies.push({
    name: kQuartoHtmlDependency,
    scripts,
    stylesheets,
  });
  return {
    [kIncludeInHeader]: includeInHeader,
    [kIncludeAfterBody]: includeAfterBody,
    html: {
      [kDependencies]: dependencies,
      [kSassBundles]: sassBundles,
      [kHtmlPostprocessors]: [htmlFormatPostprocessor(format)],
    },
  };
}

function pandocExtras(format: Format) {
  // see if there is a max-width
  const maxWidth = format.metadata["max-width"];
  const headerIncludes = maxWidth
    ? `<style type="text/css">body { max-width: ${
      asCssSize(maxWidth)
    };}</style>`
    : undefined;

  return {
    metadata: {
      [kDocumentCss]: true,
      [kHeaderIncludes]: headerIncludes,
    },
  };
}
