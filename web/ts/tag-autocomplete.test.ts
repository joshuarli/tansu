import {
  checkTagInput,
  hideTagAutocomplete,
  invalidateTagCache,
  normalizeTagInput,
  rankTags,
} from "./tag-autocomplete.ts";
import { setupDOM, mockFetch } from "./test-helper.ts";

describe("tag-autocomplete", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();
    mock.on("GET", "/api/tags", { tags: ["alpha", "rust", "reader", "react"] });
  });

  afterAll(() => {
    mock.restore();
    cleanup();
  });

  afterEach(() => {
    hideTagAutocomplete();
    invalidateTagCache();
  });

  function getDropdown() {
    return document.querySelector(".autocomplete");
  }

  function getItems() {
    return [...(getDropdown()?.querySelectorAll(".autocomplete-item") ?? [])];
  }

  it("normalizes to lowercase tag-safe input", () => {
    expect(normalizeTagInput(" #Re ad!er ")).toBe("reader");
  });

  it("ranks exact, prefix, substring, then subsequence matches", () => {
    expect(rankTags(["reader", "react", "rust", "alpha"], "re")).toStrictEqual(["react", "reader"]);
    expect(rankTags(["alpha", "reader", "react"], "ae")).toStrictEqual(["reader"]);
    expect(rankTags(["alpha", "rust"], "")).toStrictEqual(["alpha", "rust"]);
  });

  it("opens from the tag input and excludes already-selected tags", async () => {
    invalidateTagCache();
    const inputEl = document.createElement("input");
    document.body.append(inputEl);
    inputEl.focus();

    checkTagInput(inputEl, ["react"], () => {});
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getDropdown()).not.toBeNull();
    expect(getItems().map((item) => item.textContent)).toStrictEqual([
      "#alpha",
      "#reader",
      "#rust",
    ]);

    inputEl.remove();
  });

  it("selecting an existing tag clears the input and calls onSelect", async () => {
    invalidateTagCache();
    const inputEl = document.createElement("input");
    inputEl.value = "ru";
    document.body.append(inputEl);
    inputEl.focus();

    let selected = "";
    checkTagInput(inputEl, [], (tag) => {
      selected = tag;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const item = getItems()[0] as HTMLElement | undefined;
    expect(item?.textContent).toContain("#rust");
    item?.click();

    expect(selected).toBe("rust");
    expect(inputEl.value).toBe("");
    inputEl.remove();
  });

  it("Enter creates a new tag from the tag input", async () => {
    invalidateTagCache();
    const inputEl = document.createElement("input");
    inputEl.value = "new_tag";
    document.body.append(inputEl);
    inputEl.focus();

    let selected = "";
    checkTagInput(inputEl, [], (tag) => {
      selected = tag;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getItems().some((item) => item.textContent?.includes("Create #new_tag"))).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(selected).toBe("new_tag");
    expect(inputEl.value).toBe("");

    inputEl.remove();
  });
});
