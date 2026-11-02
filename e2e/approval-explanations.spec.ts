import {test,expect} from '@playwright/test';

test('approval explains operation and risk with visible actual command [AC:approval-explanations#AC-1] [AC:approval-explanations#AC-3]',async({page})=>{
  const id='approval-explanation-ui';
  const session={id,title:'审批说明验收',mode:'chat',status:'waiting_approval',agentId:'general',metadata:{permissionMode:'auto'}};
  const command='TMP=$(mktemp -d /tmp/review.XXXXXX)\ngit clone --depth 1 https://example.test/repo "$TMP/repo"\nrm -rf "$TMP"';
  const approval={id:'explain-ui-1',sessionId:id,toolName:'bash',status:'pending',reason:'Auto-review (shell) blocked high-risk bash: Shell command matches a high-risk pattern. Prior note: duplicate reason',args:{command,timeout_ms:60000},createdAt:'2026-11-02T00:00:00Z'};
  let modelAvailable=true;
  await page.addInitScript(()=>localStorage.setItem('lab.locale','zh'));
  await page.route('**/api/sessions',r=>r.fulfill({json:{sessions:[session]}}));
  await page.route(new RegExp(`/api/sessions/${id}(?:\\?|$)`),r=>r.fulfill({json:{session,messages:[{id:'m1',seq:1,role:'assistant',parts:[{type:'tool_call',toolCallId:'c1',name:'bash',input:approval.args}]}],latestAssistant:''}}));
  await page.route('**/api/approvals**',r=>r.fulfill({json:{approvals:[approval]}}));
  await page.route('**/api/approval-explanations/**',r=>r.fulfill({json:{explanation:modelAvailable?{action:'下载仓库到临时目录，读完后清理。',risk:'rm -rf 会删除临时目录及其内容，请核对目标路径。'}:null}}));
  await page.goto('/#/chat');
  await page.getByRole('button',{name:/审批说明验收/}).first().click();
  const card=page.locator('#playMessages .approval-banner');
  await expect(card.getByText('将执行什么',{exact:true})).toBeVisible();
  await expect(card.getByText('下载仓库到临时目录，读完后清理。')).toBeVisible();
  await expect(card.getByText('为什么需要确认',{exact:true})).toBeVisible();
  await expect(card.locator('.approval-command pre')).toHaveText(command);
  await expect(card.locator('.approval-explanation__raw')).not.toHaveAttribute('open');
  await expect(card.getByRole('button',{name:'批准并继续'})).toBeEnabled();
  await page.screenshot({path:'/tmp/approval-explanation-ui.png'});
  modelAvailable=false; await page.reload();
  await page.getByRole('button',{name:/审批说明验收/}).first().click();
  await expect(card.locator('.approval-command pre')).toHaveText(command);
  await expect(card.getByRole('button',{name:'批准并继续'})).toBeEnabled();
});
