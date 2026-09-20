import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=name=>readFile(new URL(name,root),'utf8');

test('页面数字只从当前服务端数据与任务状态渲染',async()=>{
  const app=await read('assets/app.js');
  assert.match(app,/knowledge = \[\]/);
  assert.match(app,/activeStudentDashboard\?\.courses/);
  assert.match(app,/studentTaskState\.done/);
  assert.doesNotMatch(app,/c\.id==='ai'\?'64%'|'71%'/);
  assert.match(app,/当前未显示缓存数字/);
});

test('课程写操作不再使用浏览器本地伪成功',async()=>{
  const [app,teacher,student]=await Promise.all([read('assets/app.js'),read('teacher.html'),read('student.html')]);
  const source=app+teacher+student;
  for(const marker of ['showCreateCourse','createCourse','addClass','showJoinCourse','joinCourse'])assert.doesNotMatch(source,new RegExp(marker));
  assert.match(app,/JSON\.stringify\(\{activeCourse:state\.activeCourse,activeClass:state\.activeClass\}\)/);
  assert.match(source,/本演示版暂不提供新建入口/);
});

test('工作区 URL 记住页面和上下文并响应浏览器返回',async()=>{
  const app=await read('assets/app.js');
  assert.match(app,/history\[method\]/);
  assert.match(app,/addEventListener\('popstate'/);
  assert.match(app,/readWorkspaceRoute\(\)/);
  assert.match(app,/restoreWorkspaceRoute\(true\)/);
  assert.match(app,/params\.set\('course'/);
  assert.match(app,/params\.set\('class'/);
});

test('发布撤回与完成使用页面内确认窗口',async()=>{
  const [client,dialog]=await Promise.all([read('assets/task-client.js'),read('assets/dialog.js')]);
  assert.match(client,/ZhixueDialog\.ask/);
  assert.match(client,/ZhixueDialog\.input/);
  assert.doesNotMatch(client,/(^|[^.A-Za-z])confirm\(|(^|[^.A-Za-z])prompt\(/m);
  assert.match(dialog,/aria-modal/);
});

test('打印在页面内预览且不打开新窗口',async()=>{
  const client=await read('assets/export-client.js');
  assert.match(client,/exportPrintFrame/);
  assert.match(client,/contentWindow\?\.print\(\)/);
  assert.doesNotMatch(client,/window\.open\(/);
});

test('四个页面加载统一可读性样式',async()=>{
  const pages=await Promise.all(['index.html','login.html','teacher.html','student.html'].map(read));
  for(const page of pages)assert.match(page,/assets\/accessibility\.css/);
  const css=await read('assets/accessibility.css');
  assert.match(css,/正文 14px、说明 12px、按钮 13px/);
  assert.match(css,/font-size:14px!important/);
  assert.match(css,/font-size:12px!important/);
});

test('Windows 发布包内置 Node 并被一键脚本优先使用',async()=>{
  const [prepare,deploy,start,batch,attributes]=await Promise.all([read('scripts/prepare-submission.mjs'),read('scripts/deploy-and-open.ps1'),read('scripts/start-zhixue.ps1'),read('deploy-and-open.bat'),read('.gitattributes')]);
  assert.match(prepare,/copyFile\(process\.execPath, join\(runtimeDirectory, "node\.exe"\)\)/);
  assert.match(prepare,/bundledNodeRuntime/);
  assert.match(prepare,/content\.replace\(\/\\r\?\\n\/g, "\\r\\n"\)/);
  assert.match(attributes,/\*\.bat text eol=crlf/);
  assert.match(batch,/完整解压 ZIP/);
  assert.match(batch,/powershell\.exe -NoLogo -NoProfile -NonInteractive/);
  for(const script of [deploy,start]){
    assert.match(script,/runtime\\node\.exe/);
    assert.match(script,/Test-Path -LiteralPath \$bundledNode/);
  }
  assert.match(deploy,/-FilePath \$nodeExecutable/);
});
