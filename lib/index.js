/**
 * @local/dsh-jev-decision —— 基元律动 JEV 决策模型工具
 *
 * 决策模型不是对话模型：输入 state（背景）+ questions（题目），输出概率/选项/评分。
 * 走 POST {baseURL}/decision 专用接口。
 *
 * 关键约束（DSH 0.2.0-rc.2）：
 *   ctx.tools.register 对 parameters 不做编译、原样发给模型，因此 parameters 必须
 *   是完整合法 JSON Schema（顶层 type:'object' + properties + required 数组）；
 *   output.schema 走 assertSupportedJsonSchema，同样要是完整 JSON Schema。
 *   嵌套 object 必须显式 additionalProperties: false。
 */

export const name = 'dsh-jev-decision';
export const inject = ['tools', 'credentials'];

const DEFAULTS = {
  baseURL: 'https://tokenrhythm.studio/v1',
  apiKeyRef: 'TOKENRHYTHM_API_KEY',
  timeoutMs: 10000,
  maxQuestions: 16,
};

const MODEL = 'NeoHorse-Jev-4B';

const RELIABILITY_NOTE =
  '实测准确率约 87.5%（40 道客观题，35 对）。重要：返回的概率值与正确性基本无关（皮尔逊 r=-0.04），' +
  '高概率也可能错，不能靠概率筛可靠性。适合语义倾向判断、初筛、排序、打标签；' +
  '不适合精确事实核查（语言细节类问题的错误率明显偏高），也不适合作为唯一裁决依据，关键结论请自己复核。';

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const arr = (description, items) => ({ type: 'array', description, items });
const obj = (properties, required) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required === undefined ? {} : { required }),
});

const PROB_ITEM = obj({ label: str('选项名或档位序号'), p: num('该选项概率 0~1') });

function round(value, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

function toProbs(source, digits = 3) {
  return Object.entries(source ?? {}).map(([label, value]) => ({ label, p: round(value, digits) }));
}

function buildQuestions(list, maxQuestions, questionType, buildCriteria) {
  if (!Array.isArray(list) || list.length === 0) throw new Error('jev: questions 不能为空');
  if (list.length > maxQuestions) throw new Error(`jev: 单次最多 ${maxQuestions} 题，收到 ${list.length} 题，请拆分`);
  const seen = new Set();
  const questions = {};
  for (const item of list) {
    const id = String(item.id);
    if (id.length === 0) throw new Error('jev: 每题必须有非空 id');
    if (seen.has(id)) throw new Error(`jev: 题目标识重复：${id}`);
    seen.add(id);
    const instructions = typeof item.instructions === 'string' ? item.instructions.trim() : '';
    if (instructions.length === 0) throw new Error(`jev: 题目 ${id} 的 instructions 不能为空`);
    const question = { type: questionType, instructions };
    const criteria = buildCriteria === undefined ? undefined : buildCriteria(item, id);
    if (criteria !== undefined) question.criteria = criteria;
    questions[id] = question;
  }
  return questions;
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS };
  for (const [key, value] of Object.entries(rawConfig ?? {})) {
    if (value !== undefined && value !== null) config[key] = value;
  }
  for (const key of ['timeoutMs', 'maxQuestions']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`dsh-jev-decision 需要正整数 ${key}`);
  }
  for (const key of ['baseURL', 'apiKeyRef']) {
    if (typeof config[key] !== 'string' || config[key].trim().length === 0) {
      throw new Error(`dsh-jev-decision 需要非空字符串 ${key}`);
    }
  }

  const resolveKey = async () => {
    const credentials = ctx.credentials;
    if (credentials === undefined) throw new Error('jev: credentials 服务不可用');
    const ref = typeof credentials.ref === 'function' ? credentials.ref(config.apiKeyRef) : config.apiKeyRef;
    const resolved = await credentials.resolve(ref);
    const value = resolved !== null && typeof resolved === 'object' ? resolved.value : resolved;
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`jev: 凭据 ${config.apiKeyRef} 未配置，请在模型设置页填写或导出该环境变量`);
    }
    return value;
  };

  const callDecision = async (body, signal) => {
    const key = await resolveKey();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let response;
    let text;
    try {
      response = await fetch(`${config.baseURL}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`jev: 请求超时或已取消（${config.timeoutMs}ms）`);
      throw new Error(`jev: 请求失败 ${error && error.message ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`jev: 响应不是 JSON（HTTP ${response.status}）${text.slice(0, 200)}`);
    }

    if (!response.ok) {
      const code = payload && payload.code ? payload.code : 'UNKNOWN';
      const message = payload && payload.message ? payload.message : text.slice(0, 200);
      const trace = payload && payload.traceId ? ` traceId=${payload.traceId}` : '';
      const retry = payload && payload.data ? payload.data.retryAfterSeconds : undefined;
      let hint = '';
      if (response.status === 401) hint = '；密钥无效';
      else if (response.status === 403) hint = '；账号不在灰度名单';
      else if (response.status === 413) hint = '；请求体超过 1MiB，请缩短 state';
      else if (response.status === 429) hint = `；触发限流（60 秒 30 次），等待 ${retry ?? '数'} 秒后重试`;
      else if (code === 'JEV_UPSTREAM_REJECTED') hint = '；输入 token 超过约 8192，请缩短 state 或减少题数';
      else if (code === 'JEV_INVALID_REQUEST') hint = '；请求参数不合法（客户端问题，重试无意义）';
      throw new Error(`jev: HTTP ${response.status} ${code}: ${message}${hint}${trace}`);
    }

    if (!payload || typeof payload.answers !== 'object' || payload.answers === null) {
      throw new Error('jev: 响应缺少 answers 字段');
    }
    return payload;
  };

  const run = async (args, signal, buildBody, project) => {
    const state = typeof args.state === 'string' ? args.state.trim() : '';
    if (state.length === 0) throw new Error('jev: state 不能为空');
    const payload = await callDecision(buildBody(args, state), signal);
    return project(payload.answers);
  };

  const text = (value) => [{ type: 'text', text: value }];

  ctx.tools.register({
    name: 'jev_noul',
    description:
      '用 JEV 决策模型对若干判断题给出成立概率（0~1）。适合作初筛、标记、排序。' +
      RELIABILITY_NOTE +
      ' state 应写成聚焦的判断背景，不要贴长对话历史。',
    parameters: obj(
      {
        state: str('背景或待判断内容，越聚焦越准'),
        questions: arr(
          '1~16 道判断题',
          obj({ id: str('题目标识，返回时同名'), instructions: str('判断题本身，例如「这段代码是否有缺陷？」') }, [
            'id',
            'instructions',
          ]),
        ),
      },
      ['state', 'questions'],
    ),
    output: {
      schema: obj({ answers: arr('每题结果', obj({ id: str('题目标识'), p: num('成立的软概率 0~1') }, ['id', 'p'])) }, [
        'answers',
      ]),
      render: (_args, value) => text(value.answers.map((a) => `${a.id}: p=${a.p}`).join('\n')),
    },
    async execute(args, exec) {
      return run(
        args,
        exec.signal,
        (a, state) => ({ model: MODEL, state, questions: buildQuestions(a.questions, config.maxQuestions, 'noul') }),
        (answers) => ({ answers: Object.entries(answers).map(([id, ans]) => ({ id, p: round(ans.noul) })) }),
      );
    },
  });

  ctx.tools.register({
    name: 'jev_choice',
    description:
      '用 JEV 决策模型在多个选项中选一个，返回选中项与各选项概率。适合作方案权衡、分类归因。' +
      RELIABILITY_NOTE +
      ' 选项顺序即候选顺序，请按合理优先级排列。',
    parameters: obj(
      {
        state: str('背景或待决策内容，越聚焦越准'),
        questions: arr(
          '1~16 道选择题',
          obj(
            {
              id: str('题目标识，返回时同名'),
              instructions: str('选择问题本身'),
              options: arr('候选选项，至少 1 项', obj({ label: str('选项名'), description: str('选项含义说明') }, ['label'])),
            },
            ['id', 'instructions', 'options'],
          ),
        ),
      },
      ['state', 'questions'],
    ),
    output: {
      schema: obj(
        {
          answers: arr(
            '每题结果',
            obj({ id: str('题目标识'), pick: str('选中的选项名'), probs: arr('各选项概率', PROB_ITEM) }, [
              'id',
              'pick',
              'probs',
            ]),
          ),
        },
        ['answers'],
      ),
      render: (_args, value) =>
        text(
          value.answers
            .map((a) => `${a.id}: ${a.pick}（${(a.probs ?? []).map((x) => `${x.label}=${x.p}`).join(' ')}）`)
            .join('\n'),
        ),
    },
    async execute(args, exec) {
      return run(
        args,
        exec.signal,
        (a, state) => ({
          model: MODEL,
          state,
          questions: buildQuestions(a.questions, config.maxQuestions, 'choice', (item, id) => {
            const options = Array.isArray(item.options) ? item.options : [];
            if (options.length === 0) throw new Error(`jev: 题目 ${id} 至少需要 1 个选项`);
            const criteria = {};
            for (const option of options) {
              const label = typeof option.label === 'string' ? option.label.trim() : '';
              if (label.length === 0) throw new Error(`jev: 题目 ${id} 存在空选项名`);
              if (Object.hasOwn(criteria, label)) throw new Error(`jev: 题目 ${id} 选项名重复：${label}`);
              criteria[label] = typeof option.description === 'string' ? option.description : label;
            }
            return criteria;
          }),
        }),
        (answers) => ({
          answers: Object.entries(answers).map(([id, ans]) => ({
            id,
            pick: ans.choice,
            probs: toProbs(ans.probabilities),
          })),
        }),
      );
    },
  });

  ctx.tools.register({
    name: 'jev_score',
    description:
      '用 JEV 决策模型按等级量表打分，返回概率加权期望值（0 起始档位序号）与各档概率。' +
      RELIABILITY_NOTE +
      ' 注意 score 是期望值不是最高概率档；要最高概率档请自行比较 probs。legend 用于把数值翻译回档位含义。',
    parameters: obj(
      {
        state: str('背景或待评估内容，越聚焦越准'),
        questions: arr(
          '1~16 道评分题',
          obj(
            {
              id: str('题目标识，返回时同名'),
              instructions: str('评分问题本身'),
              criteria: arr('从低到高的等级描述，必须 2~10 档', str('档位描述')),
            },
            ['id', 'instructions', 'criteria'],
          ),
        ),
      },
      ['state', 'questions'],
    ),
    output: {
      schema: obj(
        {
          answers: arr(
            '每题结果',
            obj(
              {
                id: str('题目标识'),
                score: num('概率加权期望档位序号，0 起始'),
                legend: arr('档位描述，按序号升序', str('档位描述')),
                probs: arr('各档概率', PROB_ITEM),
              },
              ['id', 'score', 'legend', 'probs'],
            ),
          ),
        },
        ['answers'],
      ),
      render: (_args, value) =>
        text(
          value.answers
            .map((a) => `${a.id}: ${Number(a.score).toFixed(2)}（${a.legend[Math.round(a.score)] ?? ''}）`)
            .join('\n'),
        ),
    },
    async execute(args, exec) {
      return run(
        args,
        exec.signal,
        (a, state) => ({
          model: MODEL,
          state,
          questions: buildQuestions(a.questions, config.maxQuestions, 'score', (item, id) => {
            const criteria = Array.isArray(item.criteria) ? item.criteria : [];
            if (criteria.length < 2 || criteria.length > 10) {
              throw new Error(`jev: 题目 ${id} 的 criteria 必须 2~10 档，收到 ${criteria.length} 档`);
            }
            for (const level of criteria) {
              if (typeof level !== 'string' || level.trim().length === 0) {
                throw new Error(`jev: 题目 ${id} 的 criteria 存在空档位描述`);
              }
            }
            return criteria.slice();
          }),
        }),
        (answers) => ({
          answers: Object.entries(answers).map(([id, ans]) => ({
            id,
            score: ans.score,
            legend: Object.keys(ans.legend ?? {})
              .sort((left, right) => Number(left) - Number(right))
              .map((key) => ans.legend[key]),
            probs: toProbs(ans.probabilities),
          })),
        }),
      );
    },
  });
}
