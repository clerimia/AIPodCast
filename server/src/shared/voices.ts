// 24 系统音色（qwen3-tts-instruct-flash，docs/research/qwen3-tts-instruct-flash.md）。
// web/src/lib/voices.ts 镜像此表（shared/ 类型包本期不抽，#21 定案）。
export interface VoiceOption {
  /** 引擎 input.voice 取值（存 speakers.voice） */
  name: string
  label: string
}

export const VOICES: readonly VoiceOption[] = [
  { name: 'Cherry', label: '芊悦' },
  { name: 'Serena', label: '苏瑶' },
  { name: 'Ethan', label: '晨煦' },
  { name: 'Chelsie', label: '千雪' },
  { name: 'Momo', label: '茉兔' },
  { name: 'Vivian', label: '十三' },
  { name: 'Moon', label: '月白' },
  { name: 'Maia', label: '四月' },
  { name: 'Kai', label: '凯' },
  { name: 'Nofish', label: '不吃鱼' },
  { name: 'Bella', label: '萌宝' },
  { name: 'Eldric Sage', label: '沧明子' },
  { name: 'Mia', label: '乖小妹' },
  { name: 'Mochi', label: '沙小弥' },
  { name: 'Bellona', label: '燕铮莺' },
  { name: 'Vincent', label: '田叔' },
  { name: 'Bunny', label: '萌小姬' },
  { name: 'Neil', label: '阿闻' },
  { name: 'Elias', label: '墨讲师' },
  { name: 'Arthur', label: '徐大爷' },
  { name: 'Nini', label: '邻家妹妹' },
  { name: 'Seren', label: '小婉' },
  { name: 'Pip', label: '顽屁小孩' },
  { name: 'Stella', label: '少女阿月' },
]

const voiceNames = new Set(VOICES.map((v) => v.name))

export function isVoiceName(value: string): boolean {
  return voiceNames.has(value)
}
