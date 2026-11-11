import { useEffect, useState } from "react";

const storageKey = "vlaeval.attentionColor";
export const defaultAttentionColor = "#e5484d";

export function useAttentionColor() {
  const [color, setColor] = useState(() => {
    const stored = typeof localStorage === "undefined" ? null : localStorage.getItem(storageKey);
    return stored && /^#[0-9a-f]{6}$/i.test(stored) ? stored : defaultAttentionColor;
  });
  useEffect(() => { localStorage.setItem(storageKey, color); }, [color]);
  return [color, setColor] as const;
}
