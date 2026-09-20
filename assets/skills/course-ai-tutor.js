/** course-ai-tutor：K0/K1/K2 混合检索、确定性计算和多轮解释。 */
(function (global) {
  'use strict';
  const SKILL_ID = 'course-ai-tutor';
  const SKILL_VERSION = 'course-ai-tutor@2.0.0';
  const now = () => new Date().toISOString();
  const text = value => String(value ?? '').trim();
  const normalize = value => text(value).toLowerCase().replace(/[，。！？、；：“”‘’（）()\s]/g, '');
  const grams = value => { const input=normalize(value),result=new Set(); for(let size=2;size<=4;size+=1)for(let i=0;i<=input.length-size;i+=1)result.add(input.slice(i,i+size)); return result; };
  function score(question,item){const q=normalize(question),qg=grams(question),fields=[item.title,...(item.tags||[]),item.text,item.summary].map(normalize).filter(Boolean);let points=0;for(const field of fields){if(field.length>1&&q.includes(field))points+=Math.min(16,field.length*2);const ig=grams(field);let overlap=0;for(const gram of qg)if(ig.has(gram))overlap+=1;points+=overlap/Math.max(1,Math.min(qg.size,ig.size));}return points;}
  function calculate(question){
    const candidates=text(question).replace(/[×xX]/g,'*').replace(/÷/g,'/').match(/[\d.()+\-*/%\s]{3,}/g)||[];
    const expression=candidates.map(value=>value.replace(/\s/g,'')).filter(value=>/[+\-*/%]/.test(value)&&/\d/.test(value)).sort((a,b)=>b.length-a.length)[0];
    if(!expression||expression.length>80||!/^[\d.+\-*/()%]+$/.test(expression))return null;
    try{const value=Function(`"use strict";return (${expression})`)();return Number.isFinite(value)?{expression,value:Math.round(value*1e12)/1e12}:null}catch{return null}
  }
  function pending(reason,clarification,legacy=false){return{skill_id:SKILL_ID,skill_version:SKILL_VERSION,generated_at:now(),data_scope:'current-course-and-public-foundations',answer_status:clarification?'需澄清':legacy?'待人工处理':'建议转教师',answer_content:clarification||'当前课程资料和公共基础知识都不足以支持可靠回答。你可以补充具体课程、概念或题目条件，再决定是否转给教师。',answer_source_type:'无可靠依据',confidence:'低',related_knowledge:[],guide_questions:clarification?['请补充题目条件或希望解释的概念。']:[],follow_up_questions:clarification?['请补充题目条件或希望解释的概念。']:['是否将这个问题转给任课教师？'],personalization_basis:[],_refs:[],_evidence:[],_skill_id:SKILL_ID,_skill_version:SKILL_VERSION,_reason:reason};}
  function evidence(item,layer){if(layer==='K2')return{resourceId:item.resource_id,dbResourceId:item.db_resource_id,courseCode:item.course_code,courseName:item.course_name,title:item.title,resourceType:item.type,locator:item.locator,chunkId:item.chunk_id,version:item.version,synthetic:item.synthetic,sourceLabel:item.source_label,knowledgeLayer:'K2'};return{knowledgeId:item.id,title:item.title,domain:item.domain,locator:item.locator,version:item.version,sourceLabel:item.source_label,knowledgeLayer:item.layer};}
  function answer(input={}){
    const question=text(input.student_question);if(!question)return pending('empty_question','请先输入要解答的问题。');const arithmetic=calculate(question);
    if(arithmetic){const meaning=arithmetic.expression.includes('+')?'加法表示把两个数量合并；这里把 1 和 1 合并，得到 2。':'';return{skill_id:SKILL_ID,skill_version:SKILL_VERSION,generated_at:now(),data_scope:'K0-deterministic-calculation',answer_status:'已解答',answer_content:`${arithmetic.expression} = ${arithmetic.value}。这是由确定性计算器核验的结果。${meaning}`,answer_source_type:'通用基础知识',confidence:'高',related_knowledge:['基础算术'],guide_questions:['需要我把计算步骤展开吗？'],follow_up_questions:['需要我把计算步骤展开吗？'],personalization_basis:[],_refs:['K0 · 确定性计算器'],_evidence:[{knowledgeLayer:'K0',title:'基础算术',sourceLabel:'确定性计算器',locator:arithmetic.expression,version:'calculator-1'}],_skill_id:SKILL_ID,_skill_version:SKILL_VERSION};}
    const previous=Array.isArray(input.conversation_history)?input.conversation_history.slice(-4):[],followUp=/^(为什么|怎么理解|举个例子|再讲|换一种|还有呢|然后呢)/.test(question)&&previous.length,effective=followUp?`${previous.map(item=>`${item.role}:${item.content}`).join(' ')} ${question}`:question;
    const course=(Array.isArray(input.knowledge_base)?input.knowledge_base:[]).map(item=>({item,layer:'K2',points:score(effective,item)}));
    const common=(Array.isArray(input.common_knowledge)?input.common_knowledge:[]).map(item=>({item,layer:item.layer||'K1',points:score(effective,item)}));
    const courseHits=course.filter(hit=>hit.points>=0.22&&text(hit.item.text)).sort((a,b)=>b.points-a.points),commonHits=common.filter(hit=>hit.points>=0.22&&text(hit.item.text)).sort((a,b)=>b.points-a.points),hits=(courseHits.length?courseHits:commonHits).slice(0,3);if(!hits.length)return pending('no_reliable_evidence',question.length<3?'问题信息较少，请补充希望了解的课程、概念或题目条件。':'',!Array.isArray(input.common_knowledge));
    const primary=hits[0].layer,sourceType=primary==='K2'?'当前课程资料':primary==='K1'?'计算机公共基础':'通用基础知识',refs=hits.map(hit=>hit.layer==='K2'?String(hit.item.ref):`${hit.layer} · ${hit.item.title}`),basis=Array.isArray(input.personalization_basis)?input.personalization_basis.slice(0,4):[],levelHint=basis.length?`\n\n个性化说明：本次讲解参考了你的${basis.join('、')}，但没有把个人数据作为知识事实。`:'';
    const body=hits.map(hit=>text(hit.item.text)).join('\n\n'),methods=hits.map(hit=>text(hit.item.method)).filter(Boolean).join('\n'),summaries=hits.map(hit=>text(hit.item.summary)).filter(Boolean).join('；'),guides=[...new Set(hits.flatMap(hit=>hit.item.guide_questions||hit.item.guideQuestions||[]))].slice(0,3);
    return{skill_id:SKILL_ID,skill_version:SKILL_VERSION,generated_at:now(),data_scope:'K0-K3-authorized',answer_status:'已解答',answer_content:`## 核心知识点\n\n${body}${methods?`\n\n## 理解与解题思路\n\n${methods}`:''}${summaries?`\n\n## 小结\n\n${summaries}`:''}${levelHint}\n\n来源：${refs.join('；')}`.slice(0,2400),answer_source_type:sourceType,confidence:hits[0].points>=2?'高':'中',related_knowledge:[...new Set(hits.flatMap(hit=>hit.item.tags||[]))].slice(0,6),guide_questions:guides,follow_up_questions:guides,personalization_basis:basis,_refs:refs,_evidence:hits.map(hit=>evidence(hit.item,hit.layer)),_skill_id:SKILL_ID,_skill_version:SKILL_VERSION};
  }
  global.ZhixueSkillTutor={answer,SKILL_ID,SKILL_VERSION};
})(window);
