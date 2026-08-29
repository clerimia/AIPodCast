// 停顿/语速档位 → 数值表（docs/audio-params.md）：post 模块唯一的档位知识源，
// synthesis 编排（行级 post 覆盖 + 集级 post_rules → gap ms / atempo 系数）与
// script 模块 PATCH 校验（shared/post-params.ts 的档位枚举）共用。
// gap 归属：相邻行 i 与 i+1 之间的 gap 由后一行（i+1）的 pause 档位决定；
// 换说话人（相邻行 speakerId 不同）叠加 +400 ms，默认档位与逐行 override 下都生效。
import type { LinePost, PauseLevel, SpeedLevel } from '../../shared/post-params.js'

export const PAUSE_GAP_MS: Record<PauseLevel, number> = { 短: 400, 中: 800, 长: 1500 }
export const SPEED_FACTOR: Record<SpeedLevel, number> = { 慢: 0.9, 正常: 1.0, 快: 1.15 }
export const SPEAKER_CHANGE_EXTRA_MS = 400

export interface PostRulesLevels {
  pause: PauseLevel
  speed: SpeedLevel
}

/** 行间 gap（ms）：结果第 i 项 = 第 i 行开口前的静音（第 0 行为 0） */
export function computeGaps(
  lines: { speakerId: string; post: LinePost }[],
  rules: PostRulesLevels,
): number[] {
  return lines.map((line, i) => {
    if (i === 0) return 0
    const prev = lines[i - 1]!
    const pause = line.post.pause ?? rules.pause
    const speakerChange = line.speakerId !== prev.speakerId
    return PAUSE_GAP_MS[pause] + (speakerChange ? SPEAKER_CHANGE_EXTRA_MS : 0)
  })
}
