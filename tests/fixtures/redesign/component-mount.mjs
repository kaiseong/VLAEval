import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Section } from "../../../src/client/App";
import "./component-mount.css";

export function mount(element, props) {
  const title = typeof props.title === "string" ? props.title : "Harness component mount";
  const subtitle = typeof props.subtitle === "string" ? props.subtitle : "Test-only component entry";
  const root = createRoot(element);
  flushSync(() => {
    root.render(React.createElement(Section, {
      title,
      subtitle,
      children: React.createElement("div", { className: "qa-style-sentinel" }, "Mounted through isolated QA entry."),
    }));
  });
  const sentinel = element.querySelector(".qa-style-sentinel");
  return [{
    name: "production-section-component-mounted",
    passed: element.textContent?.includes(title) === true,
    detail: element.textContent ?? "",
  }, {
    name: "test-only-component-css-is-applied",
    passed: sentinel ? getComputedStyle(sentinel).paddingTop === "13px" : false,
    detail: `Test sentinel padding-top expected 13px; actual ${sentinel ? getComputedStyle(sentinel).paddingTop : "missing"}`,
  }];
}
