window.__ModuleLoader__.load({
  id: 'dsh-scnet-connect',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const react = require('react');

    /**
     * 设置页 section id（与 Host 侧路由 / 插件 entry id 无关，仅用于导航定位）。
     */
    const SECTION_ID = 'scnet-connect';
    /** Host 侧只读状态路由。 */
    const STATUS_PATH = '/plugins/dsh-scnet-connect/status';
    /** Host 侧「刷新模型」路由。 */
    const REFRESH_PATH = '/plugins/dsh-scnet-connect/refresh';

    const h = react.createElement;

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        fontSize: '13px',
        lineHeight: 1.55,
        color: 'inherit',
        padding: '2px 0 8px',
        maxWidth: '720px',
      },
      header: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: '12px',
      },
      title: { margin: 0, fontSize: '15px', fontWeight: 600 },
      subtitle: { margin: '2px 0 0', opacity: 0.62, fontSize: '12px' },
      group: {
        border: '1px solid rgba(128,128,128,0.28)',
        borderRadius: '10px',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      },
      groupTitle: { fontSize: '12px', fontWeight: 600, opacity: 0.72, letterSpacing: '0.02em' },
      row: { display: 'flex', gap: '8px', alignItems: 'baseline' },
      key: { minWidth: '72px', opacity: 0.62, fontSize: '12px', flex: '0 0 auto' },
      value: { wordBreak: 'break-all' },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12px',
      },
      button: {
        appearance: 'none',
        border: '1px solid rgba(128,128,128,0.38)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: '7px',
        padding: '5px 12px',
        fontSize: '12px',
        cursor: 'pointer',
        flex: '0 0 auto',
      },
      buttonDisabled: { opacity: 0.5, cursor: 'default' },
      badge: {
        display: 'inline-block',
        fontSize: '11px',
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: '4px',
        border: '1px solid rgba(128,128,128,0.35)',
        opacity: 0.8,
      },
      modelRow: {
        display: 'flex',
        gap: '8px',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        padding: '4px 0',
        borderTop: '1px dashed rgba(128,128,128,0.22)',
      },
      modelName: { display: 'flex', gap: '6px', alignItems: 'baseline', flexWrap: 'wrap' },
      muted: { opacity: 0.6 },
      warn: { color: '#c0392b' },
      errorBox: {
        border: '1px solid rgba(192,57,43,0.45)',
        borderRadius: '8px',
        padding: '8px 10px',
        color: '#c0392b',
        fontSize: '12px',
      },
      footer: { fontSize: '11.5px', opacity: 0.55, lineHeight: 1.5 },
      list: { display: 'flex', flexDirection: 'column' },
    };

    function formatExpiry(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return undefined;
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return undefined;
      const days = Math.floor((ms - Date.now()) / 86400000);
      if (days < 0) return '已过期';
      return `还剩约 ${days} 天`;
    }

    function credentialSourceText(source) {
      if (source === 'client-file') return 'SCNet 客户端凭据文件';
      if (source === 'config') return '插件配置里的 apiKey（明文）';
      if (source === 'unavailable') return '不可用';
      return source || '未知';
    }

    function useStatus() {
      const [state, setState] = react.useState({ loading: true, data: null, error: null, refreshing: false });

      const load = react.useCallback(async () => {
        try {
          const response = await fetch(STATUS_PATH, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          const body = await response.json().catch(() => null);
          if (!response.ok) throw new Error(body && body.error ? body.error : `HTTP ${response.status}`);
          setState((prev) => ({ ...prev, loading: false, error: null, data: body }));
        } catch (error) {
          setState((prev) => ({ ...prev, loading: false, error: String((error && error.message) || error) }));
        }
      }, []);

      react.useEffect(() => {
        let alive = true;
        load().then(() => {
          if (!alive) return;
        });
        return () => {
          alive = false;
        };
      }, [load]);

      const refresh = react.useCallback(async () => {
        setState((prev) => ({ ...prev, refreshing: true, error: null }));
        try {
          const response = await fetch(REFRESH_PATH, {
            method: 'POST',
            headers: { accept: 'application/json' },
          });
          const body = await response.json().catch(() => null);
          if (!response.ok) throw new Error(body && body.error ? body.error : `HTTP ${response.status}`);
          setState({ loading: false, refreshing: false, error: null, data: body });
        } catch (error) {
          setState((prev) => ({
            ...prev,
            refreshing: false,
            error: String((error && error.message) || error),
          }));
        }
      }, []);

      return { ...state, refresh };
    }

    function AccountGroup({ data }) {
      const account = data && data.account;
      const credential = data && data.credential;
      const rows = [];

      if (account) {
        rows.push(
          h(
            'div',
            { style: styles.row, key: 'name' },
            h('span', { style: styles.key }, '账号'),
            h(
              'span',
              { style: styles.value },
              account.userName || '(未命名)',
              account.userId ? h('span', { style: styles.muted }, `　ID ${account.userId}`) : null,
            ),
          ),
        );
        if (account.mobile) {
          rows.push(
            h(
              'div',
              { style: styles.row, key: 'mobile' },
              h('span', { style: styles.key }, '手机'),
              h('span', { style: styles.value }, account.mobile),
            ),
          );
        }
        rows.push(
          h(
            'div',
            { style: styles.row, key: 'login' },
            h('span', { style: styles.key }, '登录态'),
            h(
              'span',
              { style: styles.value },
              account.loggedIn ? 'SCNet 客户端已登录' : '未检测到登录态',
              account.tokenExpiresAt
                ? h('span', { style: styles.muted }, `（平台 token ${formatExpiry(account.tokenExpiresAt)}）`)
                : null,
            ),
          ),
        );
      } else {
        rows.push(
          h(
            'div',
            { style: styles.row, key: 'noaccount' },
            h('span', { style: styles.key }, '账号'),
            h('span', { style: styles.value }, '未检测到 SCNet 客户端登录信息'),
          ),
        );
      }

      rows.push(
        h(
          'div',
          { style: styles.row, key: 'cred' },
          h('span', { style: styles.key }, '模型 Key'),
          h(
            'span',
            { style: styles.value },
            credentialSourceText(credential && credential.source),
            credential && credential.maskedKey
              ? h('span', { style: { ...styles.mono, ...styles.muted } }, `　${credential.maskedKey}`)
              : null,
          ),
        ),
      );

      return h(
        'div',
        { style: styles.group },
        h('div', { style: styles.groupTitle }, '账号与凭据'),
        rows,
      );
    }

    function CatalogGroup({ data }) {
      const models = (data && data.models) || [];
      const catalog = (data && data.catalog) || {};
      const gateway = catalog.gateway;
      const children = [
        h(
          'div',
          { style: styles.row, key: 'head' },
          h('span', { style: styles.key }, '已注册'),
          h(
            'span',
            { style: styles.value },
            `${models.length} 个免费模型`,
            catalog.source === 'builtin' ? h('span', { style: styles.muted }, '（兜底：内置 SCNet-Max）') : null,
          ),
        ),
      ];

      if (models.length === 0) {
        children.push(h('div', { key: 'empty', style: styles.muted }, '没有可用模型。请先在 SCNet 客户端登录并发起一次对话。'));
      } else {
        children.push(
          h(
            'div',
            { style: styles.list, key: 'list' },
            models.map((model, index) =>
              h(
                'div',
                { style: { ...styles.modelRow, borderTop: index === 0 ? 'none' : styles.modelRow.borderTop }, key: model.id },
                h(
                  'span',
                  { style: styles.modelName },
                  h('span', { style: styles.mono }, model.id),
                  h('span', { style: styles.badge }, '免费'),
                  model.reasoning ? h('span', { style: styles.badge }, '思考') : null,
                  Array.isArray(model.input) && model.input.includes('image')
                    ? h('span', { style: styles.badge }, '图片')
                    : null,
                ),
                h(
                  'span',
                  { style: { ...styles.mono, ...styles.muted } },
                  `${model.contextWindow} ctx / ${model.maxTokens} out`,
                ),
              ),
            ),
          ),
        );
      }

      if (gateway) {
        children.push(
          h(
            'div',
            { style: { ...styles.row, ...styles.muted, fontSize: '11.5px' }, key: 'gw' },
            gateway.ok
              ? `网关校验：在线 ${gateway.count} 个模型${
                  Array.isArray(gateway.missing) && gateway.missing.length > 0
                    ? `，本地多出 ${gateway.missing.join('、')}`
                    : ''
                }`
              : `网关校验未执行/失败：${gateway.error || '未知原因'}（不影响使用）`,
          ),
        );
      }
      if (catalog.error) {
        children.push(h('div', { style: { ...styles.muted, fontSize: '11.5px' }, key: 'cerr' }, catalog.error));
      }

      return h('div', { style: styles.group }, h('div', { style: styles.groupTitle }, '模型'), children);
    }

    function ScnetCard() {
      const { loading, data, error, refreshing, refresh } = useStatus();

      const buttonStyle = refreshing ? { ...styles.button, ...styles.buttonDisabled } : styles.button;

      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: styles.header },
          h(
            'div',
            null,
            h('h3', { style: styles.title }, '超算互联网 SCNet'),
            h(
              'p',
              { style: styles.subtitle },
              '自动读取本机 SCNet 客户端的凭据与免费模型；模型请求直连 api.scnet.cn。',
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              style: buttonStyle,
              disabled: refreshing,
              onClick: refresh,
              title: '重新读取客户端模型目录，并用网关校验可用性',
            },
            refreshing ? '刷新中…' : '刷新模型',
          ),
        ),
        error ? h('div', { style: styles.errorBox }, error) : null,
        loading && !data
          ? h('div', { style: styles.muted }, '正在读取插件状态…')
          : h(
              react.Fragment,
              null,
              h(AccountGroup, { data }),
              h(CatalogGroup, { data }),
              h(
                'div',
                { style: styles.footer },
                data && data.updatedAt
                  ? `状态更新于 ${new Date(data.updatedAt).toLocaleString()}。`
                  : null,
                '模型来源：客户端目录 ~/.sclaw/agent/models.json 中 priceLabel=free 的条目；如需注册非免费模型，在插件配置里填 modelIds（逗号分隔）。',
              ),
            ),
      );
    }

    function apply(ctx) {
      try {
        ctx.effect(() => {
          const dispose = ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: SECTION_ID,
                order: 70,
                label: () => '超算互联网',
                inject: () => ({ surface: 'settings' }),
              },
              ScnetCard,
            ),
          );
          return () => {
            try {
              if (typeof dispose === 'function') dispose();
            } catch {
              // 页面卸载时宿主可能已经先释放了 slot。
            }
          };
        }, 'dsh-scnet-connect: settings section');
      } catch (error) {
        console.error('[dsh-scnet-connect] 设置页卡片注册失败（不影响模型 provider）：', error);
      }
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    exports.name = 'dsh-scnet-connect';
    return module.exports;
  },
});
