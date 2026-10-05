import { useMemo } from "react";
import type { FkResult } from "../../kinematics/contracts";
import type { FkState } from "../analysis/fk-controller";
import type { FrameWindow } from "../analysis/series";
import { TracePlot } from "../charts/TracePlot";
import "./fk.css";

const axes = ["X", "Y", "Z", "Roll", "Pitch", "Yaw"] as const;
const sides = ["right", "left"] as const;
const display = (value: number | null, factor = 1) => value === null ? "unavailable" : (value * factor).toLocaleString("en-US", { maximumSignificantDigits: 5 });

/** Display conversion only: samples, summaries and native grippers remain untouched. */
export function fkPoseSeries(result: FkResult, fps: number) {
  return sides.flatMap((side) => axes.map((axis, index) => ({
    side, axis, unit: index < 3 ? "mm" : "deg",
    series: {
      fps, frames: result.samples.map((sample) => sample.frame),
      predicted: result.samples.map((sample) => index < 3
        ? (sample.arms[side].pose.predicted.translationM?.[index] ?? null)
        : (sample.arms[side].pose.predicted.rpyDeg[index - 3] ?? null)).map((value) => value === null ? null : value * (index < 3 ? 1000 : 1)),
      target: result.samples.map((sample) => index < 3
        ? (sample.arms[side].pose.target.translationM?.[index] ?? null)
        : (sample.arms[side].pose.target.rpyDeg[index - 3] ?? null)).map((value) => value === null ? null : value * (index < 3 ? 1000 : 1)),
    },
  })));
}

export type FKPanelProps = {
  readonly state: FkState;
  readonly fps: number;
  readonly sourceFrame: number | null;
  readonly window: FrameWindow;
  readonly onFrameSelect: (frame: number) => void;
};
export function FKPanel(props: FKPanelProps) {
  const result = props.state.status === "ready" ? props.state.result : null;
  const channels = useMemo(() => result ? fkPoseSeries(result, props.fps) : [], [result, props.fps]);
  if (!result) return <section className="fk-panel" aria-label="Derived pose"><h2>Derived pose</h2>
    <p role="status">{props.state.status === "pending" ? "Deriving full first-step trace in a Worker…" : props.state.status === "unavailable" ? props.state.reason : ""}</p>
    <p>Raw joint and gripper analysis remains available.</p></section>;
  const selected = result.samples.find((sample) => sample.frame === props.sourceFrame);
  return <section className="fk-panel" aria-label="Derived pose" data-fk-generation={result.generation}>
    <header><h2>Shoulder-relative derived pose</h2>
      <p>Commanded-action / first-step derived pose, not a measured trajectory or success metric. Grippers remain separate in native units.</p>
      <p>{result.profile.model} · {result.profile.revision} · {result.profile.rootLink} → {result.profile.tips.right} / {result.profile.tips.left}</p>
      <p className="fk-digest">URDF SHA256 {result.profile.urdfSha256} · Profile {result.profileHash}</p>
      <p>User-declared: {result.jointUnit} · absolute joint position · nominal sign/zero confirmed. R=Rz(yaw)Ry(pitch)Rx(roll).</p>
      <p>Frame {props.sourceFrame ?? "unavailable"} · Window {props.window.startFrame}–{props.window.endFrame}</p>
      <div className="trace-plot__legend"><span><i />Prediction (solid)</span><span><i />GT (dashed)</span></div>
    </header>
    {sides.map((side) => {
      const summary = result.summaries[side];
      const arm = selected?.arms[side];
      const singular = arm && [arm.pose.predicted, arm.pose.target].some((pose) => pose.quaternionXyzw !== null && (pose.rpyDeg[0] === null || pose.rpyDeg[2] === null));
      return <section className="fk-arm" key={side} aria-label={`${side} pose`}>
        <h3>{side === "right" ? "Right" : "Left"} arm · {result.profile.tips[side]}</h3>
        <dl className="fk-errors">
          {(["translationM", "orientationRad"] as const).map((key) => {
            const metric = summary[key], factor = key === "translationM" ? 1000 : 180 / Math.PI;
            return <div key={key} data-fk-error={key} data-count={metric.count} data-mean={metric.mean === null ? "unavailable" : metric.mean * factor}>
              <dt>{key === "translationM" ? "Position norm · mm" : "SO(3) orientation · deg"}</dt>
              <dd>Mean {display(metric.mean, factor)} · RMS {display(metric.rms, factor)} · {metric.count} pairs</dd>
              <dd>Selected {display(arm?.errors[key] ?? null, factor)}</dd>
            </div>;
          })}
        </dl>
        {singular && <p role="status" data-fk-singularity={side}>Euler singularity: roll/yaw unavailable. Position and SO(3) error remain valid.</p>}
        {!selected && <p role="status">Selected source frame unavailable; choose a recorded frame.</p>}
        {arm && !arm.valid && <p role="status">Pose gap: {arm.reasons.join(", ")}. No zero substitution.</p>}
        <div className="fk-pose-grid">{channels.filter((channel) => channel.side === side).map((channel) =>
          <article key={channel.axis} data-fk-channel={`${side}-${channel.axis}`}>
            <TracePlot series={channel.series} sourceFrame={props.sourceFrame} window={props.window}
              yDomain={null} labels={{ title: `${side === "right" ? "Right" : "Left"} ${channel.axis}`, unit: channel.unit }}
              onFrameSelect={props.onFrameSelect} compact {...(channel.unit === "deg" ? { wrapThreshold: 180 } : {})} />
          </article>)}</div>
      </section>;
    })}
    <p>Unavailable Euler components and ±180° wraps are display gaps, not interpolated motion. Error summaries cover the full episode, independent of the visible window.</p>
  </section>;
}
