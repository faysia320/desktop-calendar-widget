import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const KEY = "background-transparency";
function legacyValue() {
  try {
    const value = Number(localStorage.getItem(KEY) ?? 20);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : 20;
  } catch { return 20; }
}

export default function useTransparency() {
  const [value, setValue] = useState(legacyValue);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const queue = useRef(Promise.resolve());
  const revision = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const saved = await invoke<number | null>("load_transparency");
        if (cancelled) return;
        const restored = saved ?? legacyValue();
        // Migrate once; zero is a real value, and load errors never overwrite the file.
        if (saved === null) await invoke("save_transparency", { transparency: restored });
        if (!cancelled) { setValue(restored); setReady(true); setError(""); }
      } catch (reason) { if (!cancelled) setError(String(reason)); }
    })();
    return () => { cancelled = true; };
  }, [attempt]);

  useEffect(() => {
    document.documentElement.style.setProperty("--background-opacity", String(1 - value / 100));
  }, [value]);

  function change(next: number) {
    if (!ready || !Number.isFinite(next) || next < 0 || next > 100) return;
    setValue(next); setSaving(true); setError("");
    const current = ++revision.current;
    // Keep slider writes in order; a slow earlier write must not replace the final value.
    queue.current = queue.current.then(async () => {
      try {
        await invoke("save_transparency", { transparency: next });
        try { localStorage.setItem(KEY, String(next)); } catch { /* Native file is authoritative. */ }
        if (current === revision.current) setError("");
      } catch (reason) { if (current === revision.current) setError(String(reason)); }
      finally { if (current === revision.current) setSaving(false); }
    });
  }
  return { value, change, ready, saving, error, retry: () => setAttempt(value => value + 1) };
}
