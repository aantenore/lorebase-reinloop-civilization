// World tools given to every person. They mutate the shared World and report what happened.
// Descriptions come from the language templates; parameter names stay stable identifiers.
import { memoryNotes, memoryTools, type MemoryStore, tool, type Tool } from 'reinloop';
import type { Translate } from '../i18n.ts';
import type { World } from '../world/engine.ts';
import type { ActionResult, Resource, Rules } from '../world/types.ts';

export interface ToolHost {
  world(): World;
  rules(): Rules;
  t: Translate;
  lookMaxTiles: number;
  messageMaxChars: number;
  /** Called after every tool call with the agent id (reinloop agent name). */
  onAction(agentId: string, tool: string, args: unknown, result: ActionResult): void;
}

export function worldTools(host: ToolHost): Tool[] {
  const t = host.t;
  const wrap = <A>(name: string, description: string, params: Record<string, string | string[]>, act: (id: string, args: A) => ActionResult) =>
    tool<A>(name, description, params, (args, ctx) => {
      const result = act(ctx.agent, args ?? ({} as A));
      host.onAction(ctx.agent, name, args ?? {}, result);
      return { content: result.text, isError: !result.ok };
    });
  return [
    wrap('look', t('tools.look'), {}, (id) => host.world().look(id, host.rules(), host.lookMaxTiles)),
    wrap<{ dx: number; dy: number }>('move', t('tools.move'), { dx: `integer: ${t('tools.moveDx')}`, dy: `integer: ${t('tools.moveDy')}` }, (id, a) =>
      host.world().move(id, a.dx, a.dy)),
    wrap<{ resource: Resource }>('gather', t('tools.gather'), { resource: ['food', 'wood'] }, (id, a) =>
      host.world().gather(id, a.resource, host.rules())),
    wrap<{ amount?: number }>('eat', t('tools.eat'), { amount: `integer?: ${t('tools.eatAmount')}` }, (id, a) => host.world().eat(id, a.amount)),
    wrap('build_shelter', t('tools.build'), {}, (id) => host.world().buildShelter(id, host.rules())),
    wrap<{ to: string; resource: Resource; amount: number }>('give', t('tools.give'), { to: `string: ${t('tools.giveTo')}`, resource: ['food', 'wood'], amount: 'integer' }, (id, a) =>
      host.world().give(id, a.to, a.resource, a.amount, host.rules())),
    wrap<{ to: string; text: string }>('say', t('tools.say'), { to: `string: ${t('tools.sayTo')}`, text: `string: ${t('tools.sayText')}` }, (id, a) =>
      host.world().say(id, a.to, a.text, host.messageMaxChars)),
    wrap('rest', t('tools.rest'), {}, (id) => host.world().rest(id, host.rules())),
  ];
}

/** A personal notebook per person (reinloop memory tools, agent scope). */
export function notebookTools(t: Translate, store: MemoryStore = memoryNotes()): Tool[] {
  const { remember, recall } = memoryTools({ store, scope: 'agent', namespace: 'notebook' });
  return [{ ...remember, description: t('tools.remember') }, { ...recall, description: t('tools.recall') }];
}
