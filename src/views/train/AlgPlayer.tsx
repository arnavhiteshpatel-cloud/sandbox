/** cubing.js TwistyPlayer that plays an algorithm from its case state to solved, yellow on top. */
import { useEffect, useRef, useState } from "react";
import { IconPause, IconPlay, IconRefresh } from "../../ui/icons";
import { Seg } from "../../ui/Overlay";

const SPEEDS = [0.5, 1, 2];

export function AlgPlayer({ alg, setup = "z2", anchor = "end", size = 240, autoplay = false, testId }: { alg: string; setup?: string; anchor?: "start" | "end"; size?: number; autoplay?: boolean; testId?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<any>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    import("cubing/twisty")
      .then(({ TwistyPlayer }) => {
        if (!alive || !host.current) return;
        const p = new TwistyPlayer({
          puzzle: "3x3x3",
          alg: "",
          experimentalSetupAlg: setup,
          experimentalSetupAnchor: anchor,
          background: "none",
          controlPanel: "none",
          hintFacelets: "none",
          backView: "none",
          cameraLatitude: 28,
          cameraLongitude: 28,
        } as any);
        p.style.width = size + "px";
        p.style.height = size + "px";
        host.current.innerHTML = "";
        host.current.appendChild(p);
        player.current = p;
        try {
          p.experimentalModel.playingInfo.addFreshListener((info: any) => alive && setPlaying(!!info.playing));
        } catch {
          /* older cubing.js */
        }
        setReady(true);
      })
      .catch((e) => setErr(String(e?.message ?? e)));
    return () => {
      alive = false;
      player.current?.remove();
      player.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  useEffect(() => {
    const p = player.current;
    if (!p) return;
    p.experimentalSetupAlg = setup;
    p.experimentalSetupAnchor = anchor;
    p.alg = alg;
    p.tempoScale = speed;
    try {
      p.jumpToStart?.();
    } catch {
      /* ignore */
    }
    if (autoplay) setTimeout(() => player.current?.play?.(), 350);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alg, setup, anchor, ready]);

  useEffect(() => {
    if (player.current) player.current.tempoScale = speed;
  }, [speed]);

  const step = (dir: 1 | -1) => {
    const p = player.current;
    if (!p) return;
    p.pause?.();
    p.controller?.animationController?.play({ direction: dir, untilBoundary: "move" });
  };
  const toggle = () => {
    const p = player.current;
    if (!p) return;
    if (playing) p.pause();
    else p.play();
  };

  return (
    <div className="algp" data-testid={testId}>
      <div className="algp-stage" ref={host} style={{ width: size, height: size }}>
        {err && <span className="dim">3D view unavailable</span>}
      </div>
      <div className="algp-ctrl">
        <button className="ib" title="Back to the case" onClick={() => player.current?.jumpToStart?.()}>
          <IconRefresh size={14} />
        </button>
        <button className="ib" title="Step back" onClick={() => step(-1)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 6l-7 6 7 6M7 6v12" />
          </svg>
        </button>
        <button className="ib main" title={playing ? "Pause" : "Play"} onClick={toggle} data-testid="algp-play">
          {playing ? <IconPause size={15} /> : <IconPlay size={15} />}
        </button>
        <button className="ib" title="Step forward" onClick={() => step(1)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 6l7 6-7 6M17 6v12" />
          </svg>
        </button>
        <Seg value={speed} options={SPEEDS.map((v) => ({ v, label: v + "×" }))} onChange={setSpeed} />
      </div>
    </div>
  );
}
