// 后期参数档位（docs/audio-params.md）：停顿/语速是拼接层参数（ADR-0004），
// 档位值在 script 模块（PATCH 校验）与 post 流水线（档位 → gap/atempo，M5）共用。
export const PAUSE_LEVELS = ['短', '中', '长'] as const
export const SPEED_LEVELS = ['慢', '正常', '快'] as const

export type PauseLevel = (typeof PAUSE_LEVELS)[number]
export type SpeedLevel = (typeof SPEED_LEVELS)[number]

/** 逐行后期覆盖（script_lines.post jsonb）；null/缺省 = 回退集级 post_rules */
export interface LinePost {
  pause?: PauseLevel | null
  speed?: SpeedLevel | null
}

export function isPauseLevel(value: unknown): value is PauseLevel {
  return typeof value === 'string' && (PAUSE_LEVELS as readonly string[]).includes(value)
}

export function isSpeedLevel(value: unknown): value is SpeedLevel {
  return typeof value === 'string' && (SPEED_LEVELS as readonly string[]).includes(value)
}
