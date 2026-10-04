import type { ReactNode } from "react";

export function Section({ title, subtitle, number, children, id }: {
  readonly title: string; readonly subtitle: string; readonly number?: string;
  readonly children: ReactNode; readonly id?: string;
}) {
  return <section className="panel" id={id}>
    <header className="section-heading">
      {number && <span className="step-number">{number}</span>}
      <div><h2>{title}</h2><p>{subtitle}</p></div>
    </header>
    {children}
  </section>;
}

export function Field({ label, children, hint }: {
  readonly label: string; readonly children: ReactNode; readonly hint?: string;
}) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
