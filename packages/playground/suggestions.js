const SUGGESTIONS = {
  'coding-agent': [
    '请检查当前项目中最近修改的文件，找出一个最值得修复的问题，并给出最小修复与验证结果。',
    '请为当前项目补充一个小功能：先说明实现范围，再完成代码、测试和本地验证。'
  ],
  writing: [
    '请把下面这段内容改写成一份结构清晰、语气专业、适合直接发送的中文邮件：',
    '请把我的想法整理成一篇简洁的说明，保留事实，不要补充未经提供的信息：'
  ],
  'image-gen': [
    '请生成一张适合产品首页使用的图片：主体清晰、构图简洁，并说明尺寸、风格和需要避免的元素。',
    '请把这个模糊的视觉想法整理成可直接用于图像生成的 prompt，包含主体、环境、构图、光线和风格：'
  ]
};

export function getSuggestedPrompt(profileName, index = 0) {
  const suggestions = SUGGESTIONS[profileName] ?? SUGGESTIONS['coding-agent'];
  return suggestions[Math.abs(index) % suggestions.length];
}

export function suggestionCount(profileName) {
  return (SUGGESTIONS[profileName] ?? SUGGESTIONS['coding-agent']).length;
}
