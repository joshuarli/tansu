export function button(
  label: string,
  title: string,
  onClick: (event: MouseEvent) => void,
  className = "button",
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.title = title;
  element.textContent = label;
  element.dataset["key"] = `button:${className}:${title}:${label}`;
  element.addEventListener("click", onClick);
  return element;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  for (const child of children) {
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

export function span(text: string, className = ""): HTMLSpanElement {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  return element;
}
