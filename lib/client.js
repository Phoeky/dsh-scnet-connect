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
    /** 设置页导航里的分区标题（DOM 兜底跳转时按它找行）。 */
    const SETTINGS_LABEL = 'SCNet Connect';
    /** 本插件在模型选择器里的 provider 路由名。 */
    const PROVIDER_ID = 'scnet';
    /** Host 侧只读状态路由。 */
    const STATUS_PATH = '/plugins/dsh-scnet-connect/status';
    /** Host 侧「刷新模型」路由。 */
    const REFRESH_PATH = '/plugins/dsh-scnet-connect/refresh';
    /** 免客户端登录相关路由。 */
    const LOGIN_PATHS = {
      captcha: '/plugins/dsh-scnet-connect/login/captcha',
      sms: '/plugins/dsh-scnet-connect/login/sms',
      submit: '/plugins/dsh-scnet-connect/login/submit',
      logout: '/plugins/dsh-scnet-connect/logout',
      validate: '/plugins/dsh-scnet-connect/validate',
      resume: '/plugins/dsh-scnet-connect/resume',
      freeOnly: '/plugins/dsh-scnet-connect/catalog/free-only',
    };

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
      input: {
        appearance: 'none',
        border: '1px solid rgba(128,128,128,0.38)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: '7px',
        padding: '5px 9px',
        fontSize: '12px',
        fontFamily: 'inherit',
        minWidth: 0,
        // 外层是纵向 flex：这里只能让宽度撑满、高度固定；
        // 写 flex-basis 会作用在高度上，输入框会被拉成 120px 高的大块。
        alignSelf: 'stretch',
        flex: '0 0 auto',
        height: '30px',
        boxSizing: 'border-box',
      },
      form: { display: 'flex', flexDirection: 'column', gap: '8px' },
      tabs: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
      tab: {
        appearance: 'none',
        border: '1px solid rgba(128,128,128,0.3)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: '7px',
        padding: '4px 10px',
        fontSize: '12px',
        cursor: 'pointer',
      },
      tabActive: {
        borderColor: 'rgba(64,128,255,0.75)',
        background: 'rgba(64,128,255,0.12)',
      },
      captcha: { width: '118px', height: '40px', borderRadius: '6px', cursor: 'pointer', alignSelf: 'center' },
      hint: { fontSize: '11.5px', opacity: 0.62, lineHeight: 1.5 },
      linkRow: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      badges: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginTop: '6px' },
      composerBadge: {
        appearance: 'none',
        border: '1px solid rgba(128,128,128,0.32)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: '7px',
        height: '24px',
        padding: '0 8px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        fontSize: '11.5px',
        fontFamily: 'inherit',
        cursor: 'pointer',
        maxWidth: '190px',
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      },
      composerDot: { width: '6px', height: '6px', borderRadius: '50%', flex: '0 0 auto', background: 'currentColor' },
      composerText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    };

    function formatExpiry(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return undefined;
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return undefined;
      const days = Math.floor((ms - Date.now()) / 86400000);
      if (days < 0) return '已过期';
      if (days === 0) return '今天内';
      return `还剩约 ${days} 天`;
    }

    /** 动作失败时把 `error` / `reason` 收敛成一句中文；成功返回空串。 */
    function actionErrorText(result) {
      if (!result) return '';
      if (typeof result.error === 'string' && result.error) return result.error;
      if (result.ok !== false) return '';
      if (result.reason === 'no-session') return '还没有登录会话';
      if (result.reason === 'expired') return '平台会话已过期，请重新登录';
      if (result.reason === 'network') return '网络连接失败，请稍后重试';
      return '操作失败，请稍后重试';
    }

    function formatCount(value) {
      const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
      return n.toLocaleString('zh-CN');
    }

    function credentialSourceText(source) {
      if (source === 'client-file') return 'SCNet 客户端凭据文件';
      if (source === 'config') return '插件配置里的 apiKey（明文）';
      if (source === 'login') return '免客户端登录（设置页）';
      if (source === 'unavailable') return '不可用';
      return source || '未知';
    }

    /** 「凭据来源」三选一的显示名。 */
    function sourceModeText(mode) {
      if (mode === 'client') return 'SCNet 客户端';
      if (mode === 'login') return '免客户端登录';
      return '自动（先客户端，再免客户端）';
    }

    /** 打开「设置 → SCNet Connect」。优先走外壳公开的 store 座位，失败再驱动 DOM。 */
    function openPluginSettings(ctx) {
      try {
        const seat = ctx?.slots?.entries?.('sidebar.settings')?.[0]?.store;
        const actions = seat?.create?.()?.actions;
        if (typeof actions?.openSection === 'function') {
          actions.openSection(SECTION_ID);
          return true;
        }
      } catch {
        // 外壳没有这个座位：走下面的 DOM 兜底。
      }
      try {
        const panelSelector = '[data-shortcut-modal="settings"]';
        if (!document.querySelector(panelSelector)) {
          const trigger = Array.from(
            document.querySelectorAll('button[aria-haspopup="dialog"][aria-expanded]'),
          ).find((button) => button.getAttribute('aria-expanded') !== 'true');
          trigger?.click();
        }
        // 面板与导航行不是同一帧挂上的；四次、每次 70ms 足够覆盖一次布局。
        for (const delay of [0, 70, 70, 120]) {
          setTimeout(() => {
            const scope = document.querySelector(panelSelector) || document;
            const row = Array.from(scope.querySelectorAll('button')).find(
              (button) => (button.textContent || '').trim() === SETTINGS_LABEL,
            );
            row?.click();
          }, delay);
        }
        return true;
      } catch {
        return false;
      }
    }

    function accountIsLoggedIn(data) {
      if (!data || data.suspended) return false;
      const source = data.credential && data.credential.source;
      return source === 'login' || source === 'client-file' || source === 'config';
    }

    function composerAccountLabel(data) {
      if (!data) return 'SCNet · …';
      if (data.suspended) return 'SCNet · 已停用';
      const account = data.account;
      if (account) {
        const name = account.userName || account.mobile;
        return name ? `SCNet · ${name}` : 'SCNet · 已登录';
      }
      return accountIsLoggedIn(data) ? 'SCNet · 已登录' : 'SCNet · 未登录';
    }

    /** 输入框左侧账号徽标：只在本会话选中 scnet 模型时渲染。 */
    function ComposerAccountBadgeGate(props) {
      const projection = props.useProjection && props.useProjection('modelSelection');
      const provider = (projection?.next ?? projection?.lastUsed)?.provider;
      if (provider !== PROVIDER_ID) return null;
      return h(ComposerAccountBadge, props);
    }

    function ComposerAccountBadge({ openSettings }) {
      const [data, setData] = react.useState(null);
      const [failed, setFailed] = react.useState(false);

      react.useEffect(() => {
        let alive = true;
        const load = async () => {
          try {
            const body = await fetchJson(
              STATUS_PATH,
              { headers: { accept: 'application/json' }, cache: 'no-store' },
              10_000,
            );
            if (alive) {
              setData(body);
              setFailed(false);
            }
          } catch {
            if (alive) setFailed(true);
          }
        };
        load();
        const timer = setInterval(load, 30_000);
        const onFocus = () => load();
        window.addEventListener('focus', onFocus);
        return () => {
          alive = false;
          clearInterval(timer);
          window.removeEventListener('focus', onFocus);
        };
      }, []);

      const label = failed && !data ? 'SCNet · 状态未知' : composerAccountLabel(data);
      const loggedIn = accountIsLoggedIn(data);
      const dotColor = !data ? 'currentColor' : loggedIn ? '#2e9e5b' : '#c0392b';
      const error = (data && (data.credential?.error || data.error)) || (failed ? '无法读取插件状态，请打开设置检查' : '');
      const title = `${label}${error ? `\n${error}` : ''}\n点击打开「设置 → ${SETTINGS_LABEL}」`;

      return h(
        'button',
        {
          type: 'button',
          style: { ...styles.composerBadge, opacity: data ? 0.88 : 0.65 },
          onClick: openSettings,
          title,
          'aria-label': `${label}，打开 SCNet Connect 设置`,
        },
        h('span', { style: { ...styles.composerDot, color: dotColor } }),
        h('span', { style: styles.composerText }, label),
      );
    }

    /** 免客户端登录状态 → 一句话。 */
    function loginPhaseText(login) {
      if (!login) return '未知';
      switch (login.phase) {
        case 'authorized':
          return '已登录';
        case 'pending':
          return '登录中…';
        case 'expired':
          return '会话已过期';
        case 'failed':
          return '上次登录失败';
        default:
          return '未登录';
      }
    }

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok && !(payload && typeof payload === 'object')) {
        throw new Error(`HTTP ${response.status}`);
      }
      return payload || {};
    }

    /** 带超时的 GET/POST JSON；设置页读取状态不应该无限转圈。 */
    async function fetchJson(path, init, timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(path, { ...init, signal: controller.signal });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body && body.error ? body.error : `HTTP ${response.status}`);
        return body || {};
      } catch (error) {
        if (error && error.name === 'AbortError') throw new Error('请求超时，请稍后重试');
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    function useStatus() {
      const [state, setState] = react.useState({ loading: true, data: null, error: null, refreshing: false });

      const load = react.useCallback(async () => {
        try {
          const body = await fetchJson(STATUS_PATH, { headers: { accept: 'application/json' }, cache: 'no-store' }, 15_000);
          setState((prev) => ({ ...prev, loading: false, error: null, data: body }));
        } catch (error) {
          setState((prev) => ({ ...prev, loading: false, error: String((error && error.message) || error) }));
        }
      }, []);

      react.useEffect(() => {
        load();
      }, [load]);

      const refresh = react.useCallback(async () => {
        setState((prev) => ({ ...prev, refreshing: true, error: null }));
        try {
          const body = await fetchJson(REFRESH_PATH, { method: 'POST', headers: { accept: 'application/json' } }, 30_000);
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

    /** 顶部状态摘要：一眼看出插件/凭据/登录是否正常，不用逐段读。 */
    function StatusBadges({ data }) {
      if (!data) return null;
      const items = [];
      if (data.registered === false) items.push({ text: '插件未注册', warn: true });
      else items.push({ text: '插件已注册' });
      if (data.suspended) items.push({ text: '已停用', warn: true });
      if (data.credential && data.credential.source === 'login') items.push({ text: '免客户端登录' });
      else if (data.credential && (data.credential.source === 'client-file' || data.credential.source === 'config')) {
        items.push({ text: '客户端凭据' });
      } else if (data.credential && data.credential.source === 'unavailable') {
        items.push({ text: '凭据不可用', warn: true });
      }
      if (data.login && data.login.phase === 'expired') items.push({ text: '登录已过期', warn: true });
      return h(
        'div',
        { style: styles.badges },
        items.map((item, index) =>
          h(
            'span',
            { style: item.warn ? { ...styles.badge, ...styles.warn } : styles.badge, key: index },
            item.text,
          ),
        ),
      );
    }

    /** Token 用量：累计 + 最近一次；数据来自现有 /status，不额外请求。 */
    function UsageGroup({ data }) {
      const usage = (data && data.usage) || {};
      const enabled = usage.enabled !== false;
      const requests = typeof usage.requests === 'number' ? usage.requests : 0;
      const hasUsage = requests > 0;
      const cacheRead = typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0;
      const cacheWrite = typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0;
      const last = usage.last && typeof usage.last === 'object' ? usage.last : null;
      const children = [];

      children.push(
        h(
          'div',
          { style: styles.row, key: 'total' },
          h('span', { style: styles.key }, '累计'),
          h(
            'span',
            { style: styles.value },
            hasUsage
              ? `${formatCount(usage.inputTokens)} 输入 / ${formatCount(usage.outputTokens)} 输出`
              : enabled
                ? '还没有记录到模型请求'
                : '配置里已关闭 recordUsage',
          ),
        ),
      );

      if (hasUsage) {
        children.push(
          h(
            'div',
            { style: { ...styles.row, ...styles.muted }, key: 'cache' },
            h('span', { style: styles.key }, '缓存'),
            h(
              'span',
              { style: styles.value },
              `命中 ${formatCount(cacheRead)}${cacheWrite > 0 ? ` / 写入 ${formatCount(cacheWrite)}` : ''}`,
              `　共 ${formatCount(requests)} 次请求`,
            ),
          ),
        );
      }

      if (last && last.at) {
        children.push(
          h(
            'div',
            { style: { ...styles.row, ...styles.muted }, key: 'last' },
            h('span', { style: styles.key }, '最近一次'),
            h(
              'span',
              { style: styles.value },
              `${last.model || '未知模型'} · ${formatCount(last.inputTokens)} 输入 / ${formatCount(last.outputTokens)} 输出 · ${new Date(last.at).toLocaleString()}`,
            ),
          ),
        );
      }

      children.push(
        h(
          'div',
          { style: styles.hint, key: 'hint' },
          '只统计 token 计数，不记录 prompt；上游未返回缓存字段时命中数为 0。',
        ),
      );

      return h('div', { style: styles.group }, h('div', { style: styles.groupTitle }, 'Token 用量'), children);
    }

    function AccountGroup({ data }) {
      const account = data && data.account;
      const credential = data && data.credential;
      // 账号可能来自 SCNet 客户端（带 loggedIn），也可能来自设置页的免客户端登录
      // （没有 loggedIn）。不区分来源就会把「已登录」显示成「未检测到登录态」。
      const viaLogin = Boolean(account) && (account.source === 'login' || account.fromLogin === true);
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
              viaLogin ? '免客户端登录已登录' : account.loggedIn ? 'SCNet 客户端已登录' : '未检测到登录态',
              !viaLogin && account.tokenExpiresAt
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
            h('span', { style: styles.value }, '未检测到可用账号（客户端未登录，免客户端会话也没有账号信息）'),
          ),
        );
      }

      rows.push(
        h(
          'div',
          { style: styles.row, key: 'cred' },
          h('span', { style: styles.key }, '当前模型 Key'),
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

      const credentialError = credential && credential.error;
      const loginError = data && data.login && data.login.error;
      // 登录来源的错误在下面的「免客户端登录」卡里已经展示一次；
      // 这里只在来源不同或是客户端/停用错误时显示，避免同一句红字出现两遍。
      if (credentialError && credentialError !== loginError) {
        rows.push(
          h(
            'div',
            { style: { ...styles.hint, ...styles.warn }, key: 'crederr' },
            credentialError,
          ),
        );
      }

      return h(
        'div',
        { style: styles.group },
        h('div', { style: styles.groupTitle }, '账号与凭据'),
        rows,
      );
    }

    function CatalogGroup({ data, onChanged }) {
      const models = (data && data.models) || [];
      const catalog = (data && data.catalog) || {};
      const gateway = catalog.gateway;
      const freeOnly = catalog.freeOnly !== false;
      const explicitModels = Array.isArray(catalog.explicitModels) ? catalog.explicitModels : [];
      const lockedByConfig = explicitModels.length > 0;
      const [busy, setBusy] = react.useState(false);
      const [toggleError, setToggleError] = react.useState(null);

      const toggleFreeOnly = async () => {
        setBusy(true);
        setToggleError(null);
        try {
          const result = await postJson(LOGIN_PATHS.freeOnly, { freeOnly: !freeOnly });
          if (result && result.error) setToggleError(result.error);
          if (result && result.status && onChanged) onChanged(result.status);
        } catch (error) {
          // 之前这里静默失败：开关弹回去，用户不知道发生了什么。
          setToggleError(String((error && error.message) || error));
        } finally {
          setBusy(false);
        }
      };

      const children = [
        h(
          'div',
          { style: styles.row, key: 'head' },
          h('span', { style: styles.key }, '已注册'),
          h(
            'span',
            { style: styles.value },
            `${models.length} 个模型`,
            freeOnly ? h('span', { style: styles.muted }, '（仅免费）') : null,
            catalog.source === 'builtin' ? h('span', { style: styles.muted }, '（兜底：内置 SCNet-Max）') : null,
          ),
        ),
        h(
          'label',
          { style: { ...styles.row, gap: '6px', cursor: 'pointer', alignItems: 'center' }, key: 'switch' },
          h('input', {
            type: 'checkbox',
            checked: freeOnly,
            disabled: busy || lockedByConfig,
            onChange: toggleFreeOnly,
            style: { cursor: busy || lockedByConfig ? 'default' : 'pointer', margin: 0 },
          }),
          h('span', { style: { fontSize: '12px' } }, '只显示免费模型'),
          h(
            'span',
            { style: styles.hint },
            lockedByConfig
              ? '（已用 modelIds 指定模型，这个开关不生效）'
              : freeOnly
                ? '（关闭后会把目录里所有模型都注册出来，可能产生费用）'
                : '（已显示全部模型，注意计费）',
          ),
        ),
      ];
      if (toggleError) {
        children.push(h('div', { style: { ...styles.hint, ...styles.warn }, key: 'toggle-error' }, toggleError));
      }
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
                  model.priceLabel === 'free'
                    ? h('span', { style: styles.badge }, '免费')
                    : h('span', { style: styles.badge }, model.priceLabel || '计费'),
                  model.reasoning ? h('span', { style: styles.badge }, '思考') : null,
                  Array.isArray(model.input) && model.input.includes('image')
                    ? h('span', { style: styles.badge }, '图片')
                    : null,
                  // 目录明确说「不支持工具调用」时标出来：DSH 是 agent，仍然会下发
                  // 工具定义，用户选它之前值得知道这个模型可能忽略工具。
                  model.toolCalling === false
                    ? h('span', { style: { ...styles.badge, ...styles.warn } }, '不支持工具')
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

    /**
     * 免客户端登录卡片（只做短信登录）。
     *
     * 为什么只有短信：
     *   · 账号密码要把密码交给插件进程，收益低于风险；
     *   · 微信扫码接口对非微信客户端恒 402（docs/scnet-api.md §9.4），做不了。
     */
    function LoginGroup({ data, onChanged }) {
      const login = (data && data.login) || {};
      const mode = (data && data.credentialSource) || 'auto';
      const [phone, setPhone] = react.useState('');
      const [smsCode, setSmsCode] = react.useState('');
      const [captchaText, setCaptchaText] = react.useState('');
      const [captchaImage, setCaptchaImage] = react.useState(null);
      const [busy, setBusy] = react.useState(null); // 'captcha' | 'sms' | 'submit' | 'logout' | 'validate'
      const [notice, setNotice] = react.useState(null);
      const [smsSent, setSmsSent] = react.useState(false);
      const [cooldown, setCooldown] = react.useState(0);

      const authorized = login.phase === 'authorized';
      const expired = login.phase === 'expired';

      // 发送成功后 60 秒倒计时（平台文案就是「请 60 秒后重试」）。
      react.useEffect(() => {
        if (cooldown <= 0) return undefined;
        const timer = setTimeout(() => setCooldown((n) => n - 1), 1000);
        return () => clearTimeout(timer);
      }, [cooldown]);

      const applyStatus = (result) => {
        if (result && result.status && onChanged) onChanged(result.status);
      };

      const run = async (key, path, body, successText) => {
        // 少传参数会变成 `fetch({...})`，浏览器把它发成 `/[object Object]` → 405。
        // 这种错误在界面上表现为「HTTP 405」，极难定位，所以在入口就挡掉。
        if (typeof path !== 'string' || !path.startsWith('/plugins/')) {
          setNotice({ kind: 'error', text: `内部错误：请求路径无效（${String(path)}）` });
          return null;
        }
        setBusy(key);
        setNotice(null);
        try {
          const result = await postJson(path, body);
          // 只看 `result.error` 不够：`/validate` 失败时可能只有 `ok:false` + `reason`
          // （例如 no-session），之前会把「检查登录」误报成成功。
          const failure = actionErrorText(result);
          if (failure) setNotice({ kind: 'error', text: failure });
          else if (successText) setNotice({ kind: 'ok', text: successText });
          applyStatus(result);
          return result;
        } catch (error) {
          setNotice({ kind: 'error', text: String((error && error.message) || error) });
          return null;
        } finally {
          setBusy(null);
        }
      };

      const loadCaptcha = async () => {
        setBusy('captcha');
        try {
          const result = await postJson(LOGIN_PATHS.captcha, {});
          if (result && result.ok && result.image) setCaptchaImage(result.image);
          else if (result && result.message) setNotice({ kind: 'error', text: result.message });
        } catch (error) {
          setNotice({ kind: 'error', text: String((error && error.message) || error) });
        } finally {
          setBusy(null);
        }
      };

      const sendSms = async () => {
        if (!phone.trim()) {
          setNotice({ kind: 'error', text: '请先填写手机号' });
          return;
        }
        const result = await run(
          'sms',
          LOGIN_PATHS.sms,
          { phone: phone.trim(), captcha: captchaText.trim() },
          null,
        );
        if (result && result.ok) {
          // 平台对「已注册手机号」返回 1004，前端把它当成功；这里也一样。
          setSmsSent(true);
          setCooldown(60);
          setNotice({ kind: 'ok', text: '验证码已发送，请查收短信（60 秒内可重发）' });
          setCaptchaText('');
        } else if (result) {
          const reason = result.reason;
          if (reason === 'too-frequent') setNotice({ kind: 'error', text: '发送过于频繁，请稍后再试' });
          else if (reason === 'captcha-invalid') {
            setNotice({ kind: 'error', text: '图形验证码不正确，请重新输入' });
            loadCaptcha();
          } else if (reason === 'virtual-number') {
            setNotice({ kind: 'error', text: '平台不支持虚拟号码，请更换手机号' });
          } else {
            setNotice({ kind: 'error', text: result.message || '发送失败，请稍后重试' });
            loadCaptcha();
          }
        }
      };

      const submit = async () => {
        if (!phone.trim()) {
          setNotice({ kind: 'error', text: '请填写手机号' });
          return;
        }
        if (!smsCode.trim()) {
          setNotice({ kind: 'error', text: '请填写短信验证码' });
          return;
        }
        const result = await run(
          'submit',
          LOGIN_PATHS.submit,
          { phone: phone.trim(), smsCode: smsCode.trim(), captcha: captchaText.trim() },
          '登录成功',
        );
        if (result && result.ok) {
          setSmsCode('');
          setSmsSent(false);
          setCooldown(0);
          // 未注册手机号走注册通道：账号是这次顺带建出来的，必须告知用户，
          // 否则他只会疑惑「我没注册过，怎么就能用了」。
          if (result.via === 'register') {
            setNotice({ kind: 'ok', text: '登录成功，已为你自动注册 SCNet 账号' });
          }
        } else if (result && result.error) {
          setNotice({ kind: 'error', text: result.error });
        }
      };

      const signOut = async () => {
        await run('logout', LOGIN_PATHS.logout, {}, '已退出登录（本插件已停用）');
      };

      const resume = async () => {
        await run('resume', LOGIN_PATHS.resume, {}, '已恢复使用');
      };

      const validate = async () => {
        await run('validate', LOGIN_PATHS.validate, {}, '平台会话仍然有效');
      };

      const buttonStyle = (disabled) =>
        disabled ? { ...styles.button, ...styles.buttonDisabled } : styles.button;

      const children = [
        h(
          'div',
          { style: styles.row, key: 'state' },
          h('span', { style: styles.key }, '状态'),
          h(
            'span',
            { style: styles.value },
            loginPhaseText(login),
            login.account && login.account.userName
              ? h('span', { style: styles.muted }, `　${login.account.userName}`)
              : null,
            login.account && login.account.mobile
              ? h('span', { style: styles.muted }, `　${login.account.mobile}`)
              : null,
          ),
        ),
      ];

      // 已退出登录：本插件整体停用（连客户端凭据也不再供 key）。
      // 但仍然把登录表单留在下面 —— 退出后想直接换个账号登录是常见动作，
      // 逼用户先点「恢复使用」再登录只是多余的一步（登录成功本身就会恢复供 key）。
      const suspendedView = Boolean(data && data.suspended);
      if (suspendedView) {
        children.push(
          h(
            'div',
            { key: 'suspended', style: { ...styles.hint, ...styles.warn } },
            '已退出登录，本插件已停用（不会再向 DSH 提供任何 Key，客户端凭据也一样；重启 DSH 后仍保持停用）。',
          ),
        );
        children.push(
          h(
            'div',
            { style: styles.linkRow, key: 'resume' },
            h(
              'button',
              { type: 'button', style: buttonStyle(busy !== null), disabled: busy !== null, onClick: resume },
              busy === 'resume' ? '恢复中…' : '恢复使用',
            ),
            h(
              'span',
              { style: styles.hint },
              '恢复后按「当前凭据来源」重新供 key；也可以直接在下面重新登录。',
            ),
          ),
        );
      }

      if (login.maskedKey) {
        children.push(
          h(
            'div',
            { style: styles.row, key: 'key' },
            h('span', { style: styles.key }, '登录会话 Key'),
            h(
              'span',
              { style: { ...styles.mono, ...styles.muted } },
              login.maskedKey,
              login.expiresAt ? `　${formatExpiry(login.expiresAt)}换新` : '',
            ),
          ),
        );
      }

      if (login.error) {
        children.push(h('div', { key: 'err', style: { ...styles.hint, ...styles.warn } }, login.error));
      }
      if (notice) {
        children.push(
          h(
            'div',
            {
              key: 'notice',
              role: notice.kind === 'error' ? 'alert' : 'status',
              'aria-live': notice.kind === 'error' ? 'assertive' : 'polite',
              style: { ...styles.hint, ...(notice.kind === 'error' ? styles.warn : {}) },
            },
            notice.text,
          ),
        );
      }

      // 停用状态下优先展示登录表单（重新登录即恢复供 key），不展示「检查/退出」。
      if (authorized && !suspendedView) {
        children.push(
          h(
            'div',
            { style: styles.linkRow, key: 'actions' },
            h(
              'button',
              { type: 'button', style: buttonStyle(busy !== null), disabled: busy !== null, onClick: validate, key: 'v' },
              busy === 'validate' ? '检查中…' : '检查登录',
            ),
            h(
              'button',
              {
                type: 'button',
                style: buttonStyle(busy !== null),
                disabled: busy !== null,
                onClick: signOut,
                key: 'o',
                title: '清除登录会话，并停用本插件（含客户端凭据）的 Key 供给；可随时点「恢复使用」',
              },
              busy === 'logout' ? '退出中…' : '退出登录',
            ),
            h(
              'span',
              { style: styles.hint, key: 'hint' },
              login.sessionFile ? `凭据保存在 ${login.sessionFile}` : '',
            ),
          ),
        );
        return h('div', { style: styles.group }, h('div', { style: styles.groupTitle }, '免客户端登录'), children);
      }

      children.push(
        h(
          'div',
          { style: styles.hint, key: 'intro' },
          suspendedView
            ? '重新登录会同时恢复本插件供 key。'
            : expired
              ? '平台会话已过期，重新用手机验证码登录一次即可（不需要客户端）。'
              : '不安装 SCNet 客户端也能用：用手机号收一条短信验证码登录平台，插件会自己换到模型 Key。',
        ),
      );

      children.push(
        h(
          'form',
          {
            style: styles.form,
            key: 'form',
            onSubmit: (event) => {
              event.preventDefault();
              if (busy === null) submit();
            },
          },
          h('input', {
            style: styles.input,
            placeholder: '手机号（国内 11 位）',
            value: phone,
            inputMode: 'tel',
            autoComplete: 'tel',
            maxLength: 16,
            'aria-label': '手机号',
            onChange: (event) => setPhone(event.target.value),
          }),
          h(
            'div',
            { style: styles.linkRow },
            h('input', {
              style: styles.input,
              placeholder: '图形验证码',
              value: captchaText,
              autoComplete: 'off',
              maxLength: 8,
              'aria-label': '图形验证码',
              onChange: (event) => setCaptchaText(event.target.value),
            }),
            captchaImage
              ? h('img', {
                  src: captchaImage,
                  alt: '图形验证码',
                  style: styles.captcha,
                  onClick: loadCaptcha,
                  title: '点击刷新',
                })
              : h(
                  'button',
                  { type: 'button', style: buttonStyle(busy === 'captcha'), disabled: busy === 'captcha', onClick: loadCaptcha },
                  busy === 'captcha' ? '获取中…' : '获取验证码',
                ),
          ),
          h(
            'div',
            { style: styles.linkRow },
            h(
              'button',
              {
                type: 'button',
                style: buttonStyle(busy !== null || cooldown > 0),
                disabled: busy !== null || cooldown > 0,
                onClick: sendSms,
              },
              busy === 'sms' ? '发送中…' : cooldown > 0 ? `${cooldown} 秒后可重发` : '发送短信验证码',
            ),
            smsSent
              ? h('span', { style: styles.hint }, '短信已发送，请填入下面的验证码')
              : h('span', { style: styles.hint }, '先取图形验证码，再发短信'),
          ),
          h('input', {
            style: styles.input,
            placeholder: '6 位短信验证码',
            value: smsCode,
            inputMode: 'numeric',
            autoComplete: 'one-time-code',
            maxLength: 6,
            'aria-label': '短信验证码',
            onChange: (event) => setSmsCode(event.target.value),
          }),
          h(
            'div',
            { style: styles.linkRow },
            h(
              'button',
              { type: 'submit', style: buttonStyle(busy !== null), disabled: busy !== null },
              busy === 'submit' ? '登录中…' : '登录',
            ),
            h('span', { style: styles.hint }, '短信验证码只用于这一次登录，不落盘、不回显。'),
          ),
        ),
      );

      children.push(
        h(
          'div',
          { style: styles.hint, key: 'mode' },
          `当前凭据来源：${sourceModeText(mode)}`,
          mode === 'client' ? '（设置页登录不会生效，除非把来源改成「自动」或「免客户端登录」）' : '',
        ),
      );

      return h('div', { style: styles.group }, h('div', { style: styles.groupTitle }, '免客户端登录'), children);
    }

    function ScnetCard() {
      const status = useStatus();
      const { loading, data, error, refreshing, refresh } = status;
      const [override, setOverride] = react.useState(null);
      // 登录/切换开关会带回新的 status；优先显示它，直到下一次 load/refresh。
      const view = override || data;

      /**
       * 「刷新模型」必须先把 override 清掉。
       *
       * 否则一旦本页做过登录/退出/切换开关（`override` 被写入），
       * 之后每次刷新都只是更新 `data`，而 `view` 仍然取 `override` ——
       * 请求确实发出去了，界面却停在旧状态（连「状态更新于」的时间都不动）。
       */
      const doRefresh = react.useCallback(async () => {
        setOverride(null);
        await refresh();
      }, [refresh]);

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
            h('h3', { style: styles.title }, 'SCNet Connect'),
            h(
              'p',
              { style: styles.subtitle },
              '把 SCNet 的免费模型接入 DSH。可用本机 SCNet 客户端凭据，也可以在本页用短信免客户端登录。',
            ),
            h(StatusBadges, { data: view }),
          ),
          h(
            'button',
            {
              type: 'button',
              style: buttonStyle,
              disabled: refreshing,
              onClick: doRefresh,
              title: '重新读取模型目录，并用网关校验可用性',
            },
            refreshing ? '刷新中…' : '刷新模型',
          ),
        ),
        error ? h('div', { style: styles.errorBox }, error) : null,
        loading && !view
          ? h('div', { style: styles.muted }, '正在读取插件状态…')
          : h(
              react.Fragment,
              null,
              h(AccountGroup, { data: view }),
              h(LoginGroup, { data: view, onChanged: setOverride }),
              h(CatalogGroup, { data: view, onChanged: setOverride }),
              h(UsageGroup, { data: view }),
              h(
                'div',
                { style: styles.footer },
                view && view.updatedAt
                  ? `状态更新于 ${new Date(view.updatedAt).toLocaleString()}。`
                  : null,
              ),
            ),
      );
    }

    function apply(ctx) {
      /** 输入框徽标与设置页共用同一个「打开本插件设置」动作。 */
      const openSettings = () => {
        try {
          openPluginSettings(ctx);
        } catch {
          // 导航失败不应影响对话输入区。
        }
      };

      ctx.effect(() => {
        const disposers = [];
        const keep = (dispose) => {
          if (typeof dispose === 'function') disposers.push(dispose);
        };

        try {
          keep(
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: SECTION_ID,
                  order: 70,
                  label: () => SETTINGS_LABEL,
                  inject: () => ({ surface: 'settings' }),
                },
                ScnetCard,
              ),
            ),
          );
        } catch (error) {
          console.error('[dsh-scnet-connect] 设置页卡片注册失败（不影响模型 provider）：', error);
        }

        try {
          // `conversation.input.right` 在宿主里渲染在模型选择器左侧
          // （qoder-connect 用的也是这个座位）。徽标只在当前会话选中
          // scnet 模型时显示，点击直接打开本插件设置页。
          keep(
            ctx.slots.inject('conversation.input.right', () =>
              ctx.slots.register(
                {
                  name: 'conversation.input.right',
                  id: 'scnet-connect-account',
                  order: 5,
                  inject: () => ({ openSettings }),
                },
                ComposerAccountBadgeGate,
              ),
            ),
          );
        } catch (error) {
          console.error('[dsh-scnet-connect] 输入框账号徽标注册失败（不影响模型 provider）：', error);
        }

        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              // 页面卸载时宿主可能已经先释放了 slot。
            }
          }
        };
      }, 'dsh-scnet-connect: settings section + composer account badge');
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    exports.name = 'dsh-scnet-connect';
    return module.exports;
  },
});
