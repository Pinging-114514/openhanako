const ZH_STRINGS: Record<string, string> = {
  'input.attachmentFile': '[附件] {label}',
  'input.thinkingLevel.off': '关闭',
  'input.thinkingLevel.auto': '自动',
  'input.thinkingLevel.medium': '中等',
  'input.thinkingLevel.high': '深度',
  'input.thinkingLevel.xhigh': '超高',
  'input.thinkingLevel.max': 'Max',
  'input.thinkingLevel.low': '浅思',
  'input.thinkingDesc.off': '不推理',
  'input.thinkingDesc.auto': '模型决定深度',
  'input.thinkingDesc.medium': '平衡推理',
  'input.thinkingDesc.high': '深度推理',
  'input.thinkingDesc.xhigh': '更长推理',
  'input.thinkingDesc.max': '最高推理',
  'input.thinkingDesc.low': '轻量推理',
  'input.codexSpeedLabel': '速度',
  'input.codexSpeed.standard': '标准',
  'input.codexSpeed.fast': '快速',
  'input.codexSpeed.ultrafast': '超快',
  'input.codexSpeedDesc.standard': '默认速度',
  'input.codexSpeedDesc.fast': '1.5 倍速度，用量更多',
  'input.codexSpeedDesc.ultrafast': '最快可用',
  'input.oauthAccountLabel': '账号与额度',
  'input.oauthRemaining': '余 {remaining}%',
  'input.oauthQuotaUnknown': '额度 —',
  'approval.computerApp.controlTitle': '是否允许 Hana 控制 {appName}',
  'approval.computerApp.defaultAppName': '这个应用',
  'chat.workflowInline.running': '◐ 运行中',
  'chat.workflowInline.done': '✓ 已完成',
  'chat.workflowInline.failed': '✗ 失败',
  'chat.workflowInline.aborted': '⊘ 已终止',
  'settings.skills.toggleEnableNamed': '启用 {name}',
  'settings.skills.toggleDisableNamed': '关闭 {name}',
  'preview.fileMovedOrDeleted': '原稿件已移动或者删除',
};

export function createTestTranslator(extra: Record<string, string> = {}) {
  const strings = { ...ZH_STRINGS, ...extra };
  return (key: string, params?: Record<string, string | number>) => {
    const template = strings[key];
    if (!template) return key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
  };
}

export function installWindowTestT(extra?: Record<string, string>) {
  const t = createTestTranslator(extra);
  window.t = t as typeof window.t;
  return t;
}
