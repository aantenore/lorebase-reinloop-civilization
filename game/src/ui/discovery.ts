import { config } from '../config';
import { roleLabel, t } from '../i18n';
import { store } from '../state/store';
import { h, uiRoot } from './dom';
import { itemIcon } from './itemIcons';
import { panels } from './panels';

/** Fanfare banner for a new technology: "Scoperta: Ceramica — sblocca …". Click opens the economy. */
export function mountDiscoveryBanner(): void {
  const host = h('div', { class: 'discoveries' });
  uiRoot().append(host);

  store.on('discovery', ({ tech, by, role }) => {
    const unlocks = (tech.unlocks ?? []).map((code) => store.economy.recipes.get(code)?.name ?? store.economy.techs.get(code)?.name ?? store.itemName(code));
    const who = store.resolve(by)?.name ?? by;
    const banner = h(
      'div',
      { class: 'px discovery', onclick: () => panels.set('economy', true) },
      h('div', { class: 'disc-rays' }),
      h('div', { class: 'disc-icons' }, ...(tech.unlocks ?? []).slice(0, 4).map((c) => itemIcon(c, store.itemName(c), 'ico disc-ico'))),
      h('div', { class: 'disc-title' }, t('disc.title', { name: tech.name })),
      unlocks.length ? h('div', { class: 'disc-unlocks' }, t('disc.unlocks', { list: unlocks.join(', ') })) : null,
      tech.description ? h('div', { class: 'disc-desc' }, tech.description) : null,
      h('div', { class: 'disc-by' }, t('disc.by', { who, role: roleLabel(role) })),
    );
    host.append(banner);
    while (host.children.length > 2) host.firstElementChild?.remove();
    setTimeout(() => banner.classList.add('out'), config.minds.discoveryBannerMs);
    setTimeout(() => banner.remove(), config.minds.discoveryBannerMs + 600);
  });
}
