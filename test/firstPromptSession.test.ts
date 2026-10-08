import assert from 'node:assert/strict';
import { it } from 'node:test';
import { isFirstPromptSession } from '../src/main/firstPromptSession';
it('首页地址分配匹配真实 /a/chat/s/ID 路径，不能把首发当成切会话',()=>{
 assert.equal(isFirstPromptSession('https://chat.deepseek.com/','https://chat.deepseek.com/a/chat/s/23f71e4f-1760-4afc-850d-0ab995fa9ab3?x=1'),true);
});
it('拒绝简化假路径、空ID、已有会话、不同origin及多余路径段',()=>{
 for(const [from,to] of [
 ['https://chat.deepseek.com/','https://chat.deepseek.com/a/chat/fake'],
 ['https://chat.deepseek.com/','https://chat.deepseek.com/a/chat/s/'],
 ['https://chat.deepseek.com/a/chat/s/one','https://chat.deepseek.com/a/chat/s/two'],
 ['https://chat.deepseek.com/','https://example.com/a/chat/s/two'],
 ['https://chat.deepseek.com/','https://chat.deepseek.com/a/chat/s/one/extra'],
 ]) assert.equal(isFirstPromptSession(from!,to!),false);
});
