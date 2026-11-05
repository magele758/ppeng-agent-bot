import {test,expect} from '@playwright/test';
test('群聊菜单与分组管理统一收起 [AC:sidebar-unified-menu#AC-1]',async({page})=>{
  await page.route('**/api/bot-rooms',r=>r.fulfill({json:{rooms:[{id:'menu-room',title:'Menu Room',botIds:[],status:'active'}]}}));
  await page.goto('/#/bot');
  const row=page.getByTestId('play-group-row').filter({hasText:'Menu Room'}).first();
  await expect(row).toBeVisible();
  await expect(row.getByTestId('play-group-delete')).toBeHidden();
  await row.getByRole('button',{name:'Menu Room 的更多操作'}).click();
  await expect(row.getByTestId('play-group-delete')).toBeVisible();
});
