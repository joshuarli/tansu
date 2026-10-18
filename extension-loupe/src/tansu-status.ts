import type { SendToTansuResponse } from "./tansu-schemas.ts";

export type TansuStatusActionKind = "open-note" | "open-options";

export interface TansuStatus {
  text: string;
  action?: { kind: TansuStatusActionKind; label: string };
}

function countImages(count: number): string {
  return `${count} ${count === 1 ? "image" : "images"}`;
}

export function describeTansuResponse(response: SendToTansuResponse): TansuStatus {
  if (!response.ok) {
    return response.reason === "not-configured"
      ? {
          text: response.error,
          action: { kind: "open-options", label: "Open settings" },
        }
      : { text: `Could not import to Tansu: ${response.error}` };
  }
  const parts = ["Imported to Tansu"];
  if (response.imagesLocalized > 0) {
    parts.push(countImages(response.imagesLocalized));
  }
  if (response.imagesFailed > 0) {
    parts.push(`${response.imagesFailed} stayed remote`);
  }
  return {
    text: parts.join(" · "),
    action: { kind: "open-note", label: "Open note" },
  };
}
