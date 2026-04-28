import {
  createWikiLinkExtension,
  createWikiImageExtension,
  createCalloutExtension,
} from "@joshuarli98/md-wysiwyg";

export const editorExtensions = [
  createWikiLinkExtension(),
  createWikiImageExtension({
    resolveUrl: (name) => `/z-images/${encodeURIComponent(name)}`,
  }),
  createCalloutExtension(),
];
