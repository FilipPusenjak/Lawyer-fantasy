"use client";

import { useState } from "react";
import { Field, Input, Select } from "@/components/ui";
import { EVENT_LABELS, PRESET_LABELS, presetScoring, SCORING_PRESETS, type ScoringPreset, type ScoringSettings } from "@/lib/settings";
import { SECONDS_PER_PICK_CHOICES, VALUED_EVENT_TYPES } from "./settings-form";

type Values = Record<string, string>;

function toStrings(s: ScoringSettings): Values {
  const out: Values = { firmMultiplier: String(s.firmMultiplier), filingWeeklyCap: String(s.filingWeeklyCap) };
  for (const t of VALUED_EVENT_TYPES) out[`value_${t}`] = String(s.values[t]);
  return out;
}

const PRESETS: ScoringPreset[] = [...SCORING_PRESETS, "custom"];

/** Preset select + every point value. Picking a preset fills the values; editing any value switches to Custom. */
export function ScoringFields({ initial, disabled }: { initial: ScoringSettings; disabled?: boolean }) {
  const [preset, setPreset] = useState<ScoringPreset>(initial.preset);
  const [values, setValues] = useState<Values>(() => toStrings(initial));

  function choose(p: ScoringPreset) {
    setPreset(p);
    if (p !== "custom") setValues(toStrings(presetScoring(p)));
  }
  function edit(name: string, v: string) {
    setValues((s) => ({ ...s, [name]: v }));
    setPreset("custom");
  }
  const input = (name: string, extra?: { min?: number; max?: number }) => (
    <Input
      type="number"
      step="any"
      min={extra?.min ?? -100}
      max={extra?.max ?? 100}
      name={name}
      value={values[name] ?? ""}
      onChange={(e) => edit(name, e.target.value)}
      disabled={disabled}
      required
      className="w-24 text-right"
    />
  );

  return (
    <div className="space-y-3">
      <Field label="Preset" hint="Picking a preset fills in its values. Changing any value switches to Custom.">
        <Select name="preset" value={preset} onChange={(e) => choose(e.target.value as ScoringPreset)} disabled={disabled}>
          {PRESETS.map((p) => (
            <option key={p} value={p}>
              {PRESET_LABELS[p]}
            </option>
          ))}
        </Select>
      </Field>
      <div className="rounded-xl border border-line">
        {VALUED_EVENT_TYPES.map((t) => (
          <label key={t} className="flex min-h-12 items-center gap-3 border-b border-line px-3 py-1.5 last:border-b-0">
            <span className="min-w-0 flex-1 text-sm">{EVENT_LABELS[t]}</span>
            {input(`value_${t}`)}
          </label>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Firm multiplier" hint="Firms get this × each event on their cases.">
          {input("firmMultiplier", { min: 0, max: 5 })}
        </Field>
        <Field label="Weekly filing cap" hint="Max filing points per lawyer per week.">
          {input("filingWeeklyCap", { min: 0, max: 100 })}
        </Field>
      </div>
    </div>
  );
}

/** Seconds per pick: common choices plus a custom number. */
export function DraftClockFields({ secondsPerPick, disabled }: { secondsPerPick: number; disabled?: boolean }) {
  const isPreset = (SECONDS_PER_PICK_CHOICES as readonly number[]).includes(secondsPerPick);
  const [choice, setChoice] = useState(isPreset ? String(secondsPerPick) : "custom");
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Time per pick">
        <Select name="secondsChoice" value={choice} onChange={(e) => setChoice(e.target.value)} disabled={disabled}>
          {SECONDS_PER_PICK_CHOICES.map((s) => (
            <option key={s} value={s}>
              {s < 60 ? `${s} seconds` : s === 60 ? "1 minute" : `${s / 60} minutes`}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </Select>
      </Field>
      {choice === "custom" ? (
        <Field label="Seconds" hint="15 to 600">
          <Input
            type="number"
            name="customSeconds"
            min={15}
            max={600}
            step={1}
            inputMode="numeric"
            defaultValue={isPreset ? 75 : secondsPerPick}
            disabled={disabled}
            required
          />
        </Field>
      ) : null}
    </div>
  );
}
