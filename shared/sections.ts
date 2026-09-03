/**
 * The closed vocabulary of note sections the parser indexes and the inference contract
 * answers over. This is schema, not a tuning knob: changing it changes the database enum,
 * the parser and the stored labels together, so the evaluation loop must never touch it.
 */
export const INFERABLE_SECTIONS = [
  "CLAIM",
  "SETTING",
  "AUTHOR_LIMITATIONS",
  "REVIEWER_CRITICISMS",
  "REPRODUCIBILITY",
] as const;

export type InferableSection = (typeof INFERABLE_SECTIONS)[number];

export function isInferableSection(value: unknown): value is InferableSection {
  return (INFERABLE_SECTIONS as readonly unknown[]).includes(value);
}

/**
 * Sections that must never be merged into one another. "저자가 인정한 한계" and "리뷰어
 * 지적" are different claims about a paper — one is the authors speaking, the other is a
 * reviewer — and collapsing them is the specific failure this project refuses. The pairing
 * is recorded here so evaluation can detect a swap rather than scoring it as a plain miss.
 */
export const PAIRED_SECTIONS: Partial<
  Record<InferableSection, InferableSection>
> = {
  AUTHOR_LIMITATIONS: "REVIEWER_CRITICISMS",
  REVIEWER_CRITICISMS: "AUTHOR_LIMITATIONS",
};
