import { memo, useId } from "react";
import type { CSSProperties } from "react";
import type { AlgorithmRecommendation } from "../types";
import { useTilt } from "../hooks/useTilt";
import { Badge, Button, Meter } from "./ui";
import type { Tone } from "./ui";
import { Icon } from "./icons";

/* Styles live in views/ModelsView.css (md- prefix); this card is only used there. */

interface Props {
  rec: AlgorithmRecommendation;
  /** Competition rank (1, 1, 3, ...): tied scores share a rank. */
  rank: number;
  /** How many algorithms share this exact score (1 = not tied). */
  tiedWith: number;
  /** Position in the list, used only to stagger the entry animation. */
  index: number;
  onAskWhy: (algorithm: string) => void;
}

function scoreTone(score: number): Tone {
  if (score >= 0.7) return "success";
  if (score >= 0.5) return "accent";
  if (score >= 0.35) return "warning";
  return "danger";
}

function AlgoCard({ rec, rank, tiedWith, index, onAskWhy }: Props) {
  const tilt = useTilt<HTMLElement>();
  const titleId = useId();
  const pct = Math.round(rec.score * 100);
  const best = rank === 1;
  const tied = tiedWith > 1;

  return (
    <article
      ref={tilt.ref}
      onPointerMove={tilt.onPointerMove}
      onPointerLeave={tilt.onPointerLeave}
      className={`md-card${best ? " md-card-best" : ""}`}
      style={{ "--md-i": index } as CSSProperties}
      aria-labelledby={titleId}
    >
      <header className="md-card-head">
        <span className="md-rank" aria-hidden="true">
          #{rank}
        </span>
        <span className="sr-only">{`Rank ${rank}${tied ? `, tied with ${tiedWith - 1} other${tiedWith > 2 ? "s" : ""}` : ""}: `}</span>
        <h3 className="md-card-title" id={titleId}>
          {rec.algorithm}
        </h3>
        {best ? (
          <Badge tone="success" title={tied ? `${tiedWith} algorithms share the top score` : "Highest score for this dataset"}>
            {tied ? "Tied best fit" : "Best fit"}
          </Badge>
        ) : (
          tied && (
            <Badge title={`${tiedWith} algorithms share this score`}>tied</Badge>
          )
        )}
      </header>

      <div className="md-score">
        <span className="md-score-value">{pct}%</span>
        <span className="md-score-label">fit score</span>
      </div>
      <Meter value={rec.score} tone={scoreTone(rec.score)} label={`${rec.algorithm} fit score ${pct}%`} />

      {(rec.reasons.length > 0 || rec.caveats.length > 0) && (
        <ul className="md-points">
          {rec.reasons.map((r, i) => (
            <li key={`r${i}`} className="md-point md-point-reason">
              <Icon name="check" size={14} className="md-point-icon" />
              <span>
                <span className="sr-only">Reason: </span>
                {r}
              </span>
            </li>
          ))}
          {rec.caveats.map((c, i) => (
            <li key={`c${i}`} className="md-point md-point-caveat">
              <Icon name="alert" size={14} className="md-point-icon" />
              <span>
                <span className="sr-only">Caveat: </span>
                {c}
              </span>
            </li>
          ))}
        </ul>
      )}

      <footer className="md-card-foot">
        <Button size="sm" variant="ghost" icon="chat" onClick={() => onAskWhy(rec.algorithm)} aria-label={`Ask why ${rec.algorithm} is recommended`}>
          Ask why
        </Button>
      </footer>
    </article>
  );
}

export default memo(AlgoCard);
