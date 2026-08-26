import { getSettings } from "@/lib/settings";
import { SettingsForm } from "@/components/admin/SettingsForm";

export default async function AdminSettingsPage() {
  const settings = await getSettings();

  return (
    <div>
      <h2 className="mb-4 font-display text-xl uppercase tracking-wide text-ink">Settings</h2>
      <SettingsForm settings={settings} />
    </div>
  );
}
