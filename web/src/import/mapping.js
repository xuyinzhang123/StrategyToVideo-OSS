'use strict';
// web/src/import/mapping.js
// 字段映射（DATA_SPEC §1.7）：把「目标字段」映射到「CSV 里的某一列名」。
//
// 这是 Issue #1 验收口「只通过界面或参数映射字段即可生成 MP4，无需改源码」的落地部分：
// 下游校验器与渲染器只认目标字段（date / value / label / ...），从不认具体列名。
// 因此换一份列名完全不同的 CSV，只需要换 mapping 参数，不需要改任何代码。

const CLASS_FIELDS = {
  timeseries: { required: ['date', 'value'], optional: ['series'] },
  cross_section: { required: ['label', 'value'], optional: ['group', 'value2'] },
};

// 仅在「未显式提交映射」时兜底一次；不是契约的一部分（§1.7.1）
const ALIASES = {
  date: ['date', '日期', '时间', '交易日', '月份', '年月'],
  value: ['value', '数值', '值', '金额', '数量', '指标值'],
  series: ['series', '序列', '系列', '名称', 'name'],
  label: ['label', '名称', '标签', '项目', '对象', '渠道', 'name'],
  group: ['group', '分组', '组别', '类别'],
  value2: ['value2', '对照', '上期', '对比值', '第二数值'],
};

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

function listHeader(headerFields) {
  return headerFields.map((f) => f.text).join(' / ');
}

// 返回 { ok:true, map:{field:colIndex}, extra:[{index,text}] } 或 { ok:false, code, message }
function resolveMapping(dataClass, headerFields, mapping) {
  const spec = CLASS_FIELDS[dataClass];
  if (!spec) {
    return { ok: false, code: 'E_CLASS_UNKNOWN', message: `未知数据类别：${String(dataClass)}` };
  }
  const allowed = spec.required.concat(spec.optional);
  const headerNames = headerFields.map((f) => norm(f.text));

  // 1) 校验 mapping 形状与键名
  const provided = {};
  if (mapping !== undefined && mapping !== null) {
    if (typeof mapping !== 'object' || Array.isArray(mapping)) {
      return { ok: false, code: 'E_MAPPING_FIELD', message: 'mapping 必须是对象，例如 {"date":"日期","value":"销量"}' };
    }
    for (const key of Object.keys(mapping)) {
      if (!allowed.includes(key)) {
        return {
          ok: false,
          code: 'E_MAPPING_FIELD',
          message: `不支持的目标字段：${key}（${dataClass} 允许：${allowed.join(' / ')}）`,
        };
      }
      const v = mapping[key];
      if (v === undefined || v === null || String(v).trim() === '') continue;
      provided[key] = String(v).trim();
    }
  }

  const resolved = {};
  const missing = [];
  for (const field of allowed) {
    if (provided[field]) {
      const idx = headerNames.indexOf(norm(provided[field]));
      if (idx < 0) {
        return {
          ok: false,
          code: 'E_MAPPING_COLUMN',
          message: `映射「${field}」指向的列「${provided[field]}」不存在。文件实际表头：${listHeader(headerFields)}`,
          field,
        };
      }
      resolved[field] = idx;
      continue;
    }
    // 未显式提供 → 别名兜底
    const aliases = ALIASES[field] || [];
    const candidates = [];
    headerNames.forEach((h, i) => { if (aliases.includes(h)) candidates.push(i); });
    if (candidates.length === 1) {
      resolved[field] = candidates[0];
    } else if (candidates.length > 1) {
      return {
        ok: false,
        code: 'E_MAPPING_COLUMN',
        message: `「${field}」匹配到多列（${candidates.map((i) => headerFields[i].text).join(' / ')}），存在歧义。请显式提供 mapping 指定其中一列。`,
        field,
      };
    } else if (spec.required.includes(field)) {
      missing.push(field);
    }
  }

  if (missing.length) {
    return {
      ok: false,
      code: 'E_MAPPING_COLUMN',
      message: `无法识别必填字段：${missing.join('、')}。文件实际表头：${listHeader(headerFields)}。`
        + '请在页面上选择对应的列，或提交 mapping 参数。',
      missing,
    };
  }

  // 2) 同一列不能承担两个字段
  const usedBy = new Map();
  for (const field of Object.keys(resolved)) {
    const idx = resolved[field];
    if (usedBy.has(idx)) {
      return {
        ok: false,
        code: 'E_MAPPING_DUP',
        message: `列「${headerFields[idx].text}」同时被 ${usedBy.get(idx)} 与 ${field} 使用，不允许一列承担两个字段。`,
      };
    }
    usedBy.set(idx, field);
  }

  const extra = headerFields
    .map((f, i) => ({ index: i, text: f.text }))
    .filter((x) => !usedBy.has(x.index));

  return { ok: true, map: resolved, extra };
}

module.exports = { CLASS_FIELDS, ALIASES, resolveMapping, norm };
