import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Pause, Speed } from '@/lib/api/types'

// 停顿/语速档位下拉（frontend-structure.md「跨半区共享的行内原子」）：
// 集级默认（post_rules）与逐行覆盖（script_lines.post）两种形态共用。
// 档位值以 docs/audio-params.md 为准：停顿 短/中/长、语速 慢/正常/快。
// 行级形态（withFollowDefault）多一个「集级」回退项，选中即清除覆盖（PATCH null）。

const PAUSE_LEVELS: Pause[] = ['短', '中', '长']
const SPEED_LEVELS: Speed[] = ['慢', '正常', '快']

/** Radix SelectItem 不允许空串值，「跟随集级」用哨兵 */
const FOLLOW_DEFAULT = 'default'

export interface PostLevelPatch {
  pause?: Pause | null
  speed?: Speed | null
}

export function PauseSpeedSelect({
  value,
  withFollowDefault = false,
  onChange,
}: {
  /** 当前生效档位；pause/speed 为 null = 跟随集级默认（仅行级会出现） */
  value: { pause?: Pause | null; speed?: Speed | null }
  /** 行级形态：显示「集级」回退项；集级形态只有三个具体档位 */
  withFollowDefault?: boolean
  /** 单选即发：只带被改的那个键（null = 清除逐行覆盖） */
  onChange: (patch: PostLevelPatch) => void
}) {
  return (
    <>
      <LevelSelect
        label="停顿"
        levels={PAUSE_LEVELS}
        value={value.pause}
        withFollowDefault={withFollowDefault}
        onChange={(pause) => onChange({ pause })}
      />
      <LevelSelect
        label="语速"
        levels={SPEED_LEVELS}
        value={value.speed}
        withFollowDefault={withFollowDefault}
        onChange={(speed) => onChange({ speed })}
      />
    </>
  )
}

function LevelSelect<L extends string>({
  label,
  levels,
  value,
  withFollowDefault,
  onChange,
}: {
  label: string
  levels: L[]
  value: L | null | undefined
  withFollowDefault: boolean
  onChange: (value: L | null) => void
}) {
  return (
    <Select
      value={value ?? (withFollowDefault ? FOLLOW_DEFAULT : (levels[0] as L))}
      onValueChange={(v) => onChange(v === FOLLOW_DEFAULT ? null : (v as L))}
    >
      <SelectTrigger size="sm" className="h-7 gap-1 px-2 text-xs" aria-label={`${label}档位`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {withFollowDefault && (
          <SelectItem value={FOLLOW_DEFAULT} className="text-xs">
            {label}·集级
          </SelectItem>
        )}
        {levels.map((level) => (
          <SelectItem key={level} value={level} className="text-xs">
            {label}·{level}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
