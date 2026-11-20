import { Frame } from "@nativescript/core";

export function openPegBounce(): void {
  Frame.topmost()?.navigate("phone-ui/peg-bounce-settings-page");
}
