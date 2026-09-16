const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SKILL_FILES = [
  "course-ai-tutor.js",
  "academic-performance-analyzer.js",
  "classroom-interaction-generator.js",
  "course-content-optimizer.js",
  "teacher-answer-manager.js",
  "skill-registry.js",
];

/**
 * 在隔离上下文中加载浏览器侧 Skill，避免本地服务为演示逻辑再维护一份副本。
 * 真实接入 OpenClaw 时，可由服务端直接调用平台返回的同名 Skill。
 */
function loadZhixueSkills(skillDir) {
  const sandbox = {
    window: {},
    console: {
      error: console.error,
      warn: console.warn,
    },
  };
  vm.createContext(sandbox);

  for (const fileName of SKILL_FILES) {
    const filePath = path.join(skillDir, fileName);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Skill 文件不存在：${filePath}`);
    }
    vm.runInContext(fs.readFileSync(filePath, "utf8"), sandbox, {
      filename: filePath,
    });
  }

  const runtime = sandbox.window;
  const expected = [
    "ZhixueSkillTutor",
    "ZhixueSkillAnalyzer",
    "ZhixueSkillInteraction",
    "ZhixueSkillContentOptimizer",
    "ZhixueSkillAnswerManager",
    "ZhixueSkillRegistry",
  ];
  for (const name of expected) {
    if (!runtime[name]) {
      throw new Error(`Skill 未正确导出：${name}`);
    }
  }

  return {
    tutor: runtime.ZhixueSkillTutor,
    analyzer: runtime.ZhixueSkillAnalyzer,
    interaction: runtime.ZhixueSkillInteraction,
    optimizer: runtime.ZhixueSkillContentOptimizer,
    answerManager: runtime.ZhixueSkillAnswerManager,
    registry: runtime.ZhixueSkillRegistry,
  };
}

module.exports = { loadZhixueSkills };
