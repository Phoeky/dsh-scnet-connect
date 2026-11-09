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

    function CatalogGroup({ data, onChanged }) {
      const models = (data && data.models) || [];
      const catalog = (data && data.catalog) || {};
      const gateway = catalog.gateway;
      const freeOnly = catalog.freeOnly !== false;
      const [busy, setBusy] = react.useState(false);

      const toggleFreeOnly = async () => {
        setBusy(true);
        try {
          const result = await postJson(LOGIN_PATHS.freeOnly, { freeOnly: !freeOnly });
          if (result && result.status && onChanged) onChanged(result.status);
        } catch {
          // 失败就保持原样；下次刷新会带回真实状态。
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
            disabled: busy,
            onChange: toggleFreeOnly,
            style: { cursor: busy ? 'default' : 'pointer', margin: 0 },
          }),
          h('span', { style: { fontSize: '12px' } }, '只显示免费模型'),
          h(
            'span',
            { style: styles.hint },
            freeOnly ? '（关闭后会把目录里所有模型都注册出来，可能产生费用）' : '（已显示全部模型，注意计费）',
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
                  model.priceLabel === 'free'
                    ? h('span', { style: styles.badge }, '免费')
                    : h('span', { style: styles.badge }, model.priceLabel || '计费'),
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
          const error = result && result.error;
          if (error) setNotice({ kind: 'error', text: error });
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
      if (data && data.suspended) {
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
            h('span', { style: styles.hint }, '恢复后按「当前凭据来源」重新供 key；想彻底不用请卸载插件。'),
          ),
        );
        return h('div', { style: styles.group }, h('div', { style: styles.groupTitle }, '免客户端登录'), children);
      }

      if (login.maskedKey) {
        children.push(
          h(
            'div',
            { style: styles.row, key: 'key' },
            h('span', { style: styles.key }, '模型 Key'),
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
              style: { ...styles.hint, ...(notice.kind === 'error' ? styles.warn : {}) },
            },
            notice.text,
          ),
        );
      }

      if (authorized) {
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
          expired
            ? '平台会话已过期，重新用手机验证码登录一次即可（不需要客户端）。'
            : '不安装 SCNet 客户端也能用：用手机号收一条短信验证码登录平台，插件会自己换到模型 Key。',
        ),
      );

      children.push(
        h(
          'div',
          { style: styles.form, key: 'form' },
          h('input', {
            style: styles.input,
            placeholder: '手机号（国内 11 位）',
            value: phone,
            inputMode: 'tel',
            autoComplete: 'off',
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
            autoComplete: 'off',
            onChange: (event) => setSmsCode(event.target.value),
          }),
          h(
            'div',
            { style: styles.linkRow },
            h(
              'button',
              { type: 'button', style: buttonStyle(busy !== null), disabled: busy !== null, onClick: submit },
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
      // 登录动作会带回新的 status；优先显示它，直到下一次 load/refresh。
      const view = override || data;

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
              '免费模型直连 api.scnet.cn。凭据可以用本机 SCNet 客户端，也可以在本页登录平台（不需要装客户端）。',
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              style: buttonStyle,
              disabled: refreshing,
              onClick: refresh,
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
              h(
                'div',
                { style: styles.footer },
                view && view.updatedAt
                  ? `状态更新于 ${new Date(view.updatedAt).toLocaleString()}。`
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
