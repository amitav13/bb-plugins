// bb-plugin-doc-review — frontend entry.
//
// Registers the review panel as a file opener for Markdown, PDF, and PPTX
// (files open in a panel tab beside the chat), plus a sidebar page that lists
// every file with comments.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { ReviewOpener } from "./ui/review-opener";
import { PANEL_PATH, ReviewsPage } from "./ui/reviews-page";

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "review",
    title: "Doc Review (comments)",
    extensions: ["md", "markdown", "pdf", "pptx"],
    component: ReviewOpener,
  });

  app.slots.navPanel({
    id: "doc-review",
    title: "Doc Review",
    icon: "MessageSquare",
    path: PANEL_PATH,
    component: ReviewsPage,
  });
});
