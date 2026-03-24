/**
 * Task lifecycle rules — shared detector for completion-like task text.
 *
 * Policy: "strong-positive only". If ambiguous, return false.
 * This file is the single source of truth for task text classification.
 * Add new rules here as needed; consumers just call isCompletionReport().
 */

// ── Positive: text IS a completion report ───────────────

const COMPLETION_POSITIVE = [
  // Korean completion markers (anywhere in text)
  /완료/,                            // "완료" anywhere
  /끝\s*[.!]?\s*$/,                  // ends with "끝"
  /처리\s*됨/,                       // "처리됨"
  /해결/,                            // "해결"
  /수정\s*[했하됨]/,                  // "수정했", "수정함", "수정됨"
  /구현\s*[했하됨]/,                  // "구현했", "구현함"
  /적용\s*[했하됨]/,                  // "적용했", "적용함"
  /추가\s*[했하됨]/,                  // "추가했", "추가함"
  /삭제\s*[했하됨]/,                  // "삭제했", "삭제함"
  /개선\s*[했하됨]/,                  // "개선했", "개선함"
  /작업\s*완료/,                     // "작업 완료"
  /총\s+\d+\s*건.*(?:완료|처리|정리|삭제)/, // "총 412건 정리"
  /\d+\s*건\s*(?:삭제|정리|처리|병합|수정)/, // "112건 삭제"
  /커밋\s*(?:완료|성공|됨)/,         // "커밋 완료"
  /배포\s*(?:완료|성공|됨)/,         // "배포 완료"
  // English completion markers (anywhere in text)
  /\bresolved\b/i,                   // "resolved"
  /\bfixed\b/i,                      // "fixed"
  /\bdone\b/i,                       // "done"
  /\bcompleted?\b/i,                 // "complete" or "completed"
  /\bimplemented\b/i,                // "implemented"
  /\bfinished\b/i,                   // "finished"
  /\bmerged?\b/i,                    // "merge" or "merged"
  /\bdeployed\b/i,                   // "deployed"
  /\bshipped\b/i,                    // "shipped"
];

// ── Negative: text has future/conditional intent ────────

const FUTURE_NEGATIVE = [
  /해야/,                           // "해야 함"
  /필요/,                           // "필요"
  /예정/,                           // "예정"
  /(?:후|후에)\s/,                  // "완료 후 ~"
  /다음/,                           // "다음에"
  /남은/,                           // "남은 작업"
  /TODO/i,
  /확인\s*필요/,
  /진행\s*예정/,
  /할\s*것/,
  /해줘/,
  /부탁/,
];

/**
 * Returns true if the text reads like a completion report / status update
 * rather than an unfinished future task. Strong-positive only.
 */
export function isCompletionReport(text: string): boolean {
  const hasPositive = COMPLETION_POSITIVE.some((re) => re.test(text));
  if (!hasPositive) return false;

  const hasNegative = FUTURE_NEGATIVE.some((re) => re.test(text));
  if (hasNegative) return false;

  return true;
}
