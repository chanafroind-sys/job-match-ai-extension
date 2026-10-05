"""Stage 1: merge per-CV similarity lists into one candidate list.

Each CV version gets its own top-K list from the store, and a job's score is
its best similarity across versions. The union of per-CV top-K lists always
contains the global top-K by that score: a job missing from its best CV's
list has K better jobs on that same CV, so it can't be in the global top-K.

Pure best-score ranking would let one strong CV version take every slot, which
defeats keeping a second version. Each version is first guaranteed
`min_per_cv` of its own best jobs; the remaining slots go to the best score
overall.
"""
from dataclasses import dataclass, field


@dataclass
class Candidate:
    job_id: str
    best_cv: str
    sim: float
    sims: dict[str, float] = field(default_factory=dict)


def merge_candidates(per_cv: dict[str, list[tuple[str, float]]], top_k: int,
                     min_per_cv: int) -> list[Candidate]:
    sims: dict[str, dict[str, float]] = {}
    for cv, ranked in per_cv.items():
        for job_id, sim in ranked:
            sims.setdefault(job_id, {})[cv] = sim
    if not sims:
        return []

    def best(job_id: str) -> tuple[str, float]:
        cv, sim = max(sims[job_id].items(), key=lambda kv: kv[1])
        return cv, sim

    active_cvs = [cv for cv, ranked in per_cv.items() if ranked]
    floor = min(min_per_cv, top_k // max(1, len(active_cvs))) if len(active_cvs) > 1 else 0

    chosen: list[str] = []
    for cv in active_cvs:
        taken = 0
        for job_id, _ in per_cv[cv]:
            if taken >= floor or len(chosen) >= top_k:
                break
            if job_id not in chosen:
                chosen.append(job_id)
                taken += 1

    for job_id in sorted(sims, key=lambda j: -best(j)[1]):
        if len(chosen) >= top_k:
            break
        if job_id not in chosen:
            chosen.append(job_id)

    out = [Candidate(job_id=j, best_cv=best(j)[0], sim=best(j)[1], sims=dict(sims[j])) for j in chosen]
    out.sort(key=lambda c: -c.sim)
    return out
