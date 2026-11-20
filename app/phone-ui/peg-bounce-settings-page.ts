import { Application, Dialogs, Observable, type NavigatedData, type Page } from "@nativescript/core";
import { CAMPAIGN_LIBRARY_SETTING, CAMPAIGN_SETTING, campaignLibrary, importedCampaignName, parseImportedCampaign, type SavedCampaign } from "../apps/peg-bounce/imported-campaign";
import { getStringSetting, setStringSetting } from "../native/settings-store";

const REQUEST = 7392;
const MAX_PROJECT_BYTES = 32 * 1024 * 1024;

function pickProject(): Promise<{ text: string; name: string } | null> {
  const activity = Application.android.foregroundActivity ?? Application.android.startActivity;
  if (!activity) return Promise.reject(new Error("The Android file picker is unavailable."));
  return new Promise((resolve, reject) => {
    const result = (args: { requestCode: number; resultCode: number; intent: android.content.Intent | null }) => {
      if (args.requestCode !== REQUEST) return;
      Application.android.off(Application.android.activityResultEvent, result);
      const uri = args.intent?.getData();
      if (args.resultCode !== android.app.Activity.RESULT_OK || !uri) {
        resolve(null);
        return;
      }
      try {
        const resolver = activity.getContentResolver();
        let name = "";
        const cursor = resolver.query(uri, [android.provider.OpenableColumns.DISPLAY_NAME], null, null, null);
        if (cursor) try {
          if (cursor.moveToFirst()) name = String(cursor.getString(0)).replace(/\.json$/i, "");
        } finally { cursor.close(); }
        const stream = resolver.openInputStream(uri);
        if (!stream) throw new Error("Android could not open that file.");
        try {
          const output = new java.io.ByteArrayOutputStream();
          const buffer = Array.create("byte", 8192);
          for (let count = stream.read(buffer); count !== -1; count = stream.read(buffer)) {
            if (output.size() + count > MAX_PROJECT_BYTES) throw new Error("Choose a project file smaller than 32 MB.");
            output.write(buffer, 0, count);
          }
          resolve({ text: String(output.toString("UTF-8")), name });
        } finally {
          stream.close();
        }
      } catch (error) {
        reject(error);
      }
    };
    Application.android.on(Application.android.activityResultEvent, result);
    try {
      const intent = new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT);
      intent.addCategory(android.content.Intent.CATEGORY_OPENABLE);
      // Some Android file providers label downloaded JSON as plain text.
      intent.setType("*/*");
      activity.startActivityForResult(intent, REQUEST);
    } catch (error) {
      Application.android.off(Application.android.activityResultEvent, result);
      reject(error);
    }
  });
}

class PegBounceSettings extends Observable {
  private library(): SavedCampaign[] {
    return campaignLibrary(getStringSetting(CAMPAIGN_LIBRARY_SETTING, ""), getStringSetting(CAMPAIGN_SETTING, ""));
  }

  private save(packs: SavedCampaign[]): void {
    setStringSetting(CAMPAIGN_LIBRARY_SETTING, JSON.stringify(packs));
    setStringSetting(CAMPAIGN_SETTING, "");
  }

  private refresh(): void {
    this.set("ready", true);
    try {
      const packs = this.library();
      this.set("packRows", packs.map(pack => ({
        name: pack.name,
        remove: () => this.removePack(pack),
      })));
      this.set("canReset", packs.length > 0);
      this.set("emptyMessage", packs.length ? "" : "No imported packs yet.");
    } catch {
      this.set("canReset", true);
      this.set("packRows", []);
      this.set("emptyMessage", "The campaign library could not be read.");
    }
  }

  constructor() {
    super();
    this.refresh();
  }

  async importLevels(): Promise<void> {
    if (!this.get("ready")) return;
    this.set("ready", false);
    try {
      const project = await pickProject();
      if (!project) return;
      const { text } = project;
      const levels = parseImportedCampaign(text);
      const packs = this.library();
      if (packs.some(pack => pack.text === text)) {
        await Dialogs.alert("This campaign is already in the library.");
        return;
      }
      const result = await Dialogs.prompt({
        title: "Name this campaign", defaultText: importedCampaignName(text) || project.name || levels[0]!.name,
        okButtonText: "Import", cancelButtonText: "Cancel",
      });
      if (!result.result) return;
      const base = result.text.trim().slice(0, 70) || "Imported Campaign";
      let name = base;
      for (let suffix = 2; name === "Main Campaign" || packs.some(pack => pack.name === name); suffix++) {
        name = `${base} (${suffix})`;
      }
      this.save([...packs, { name, text }]);
      await Dialogs.alert(`Imported ${name} · ${levels.length} ${levels.length === 1 ? "level" : "levels"}.`);
    } catch (error) {
      await Dialogs.alert(error instanceof Error ? error.message : String(error));
    } finally {
      this.refresh();
    }
  }

  private async removePack(pack: SavedCampaign): Promise<void> {
    if (!this.get("ready")) return;
    this.set("ready", false);
    try {
      const confirmed = await Dialogs.confirm({
        title: "Remove campaign pack?",
        message: `Remove “${pack.name}” from Peg-Bounce?`,
        okButtonText: "Remove", cancelButtonText: "Cancel",
      });
      if (!confirmed) return;
      this.save(this.library().filter(entry => entry.name !== pack.name || entry.text !== pack.text));
    } catch (error) {
      await Dialogs.alert(error instanceof Error ? error.message : String(error));
    } finally {
      this.refresh();
    }
  }

  async resetCampaign(): Promise<void> {
    if (!this.get("ready") || !await Dialogs.confirm({
      title: "Reset Campaign?", message: "Remove all imported campaigns from Faceclaw? Main Campaign stays available.",
      okButtonText: "Reset", cancelButtonText: "Cancel",
    })) return;
    this.save([]);
    this.refresh();
  }
}

export function navigatingTo(args: NavigatedData): void {
  (args.object as Page).bindingContext = new PegBounceSettings();
}
