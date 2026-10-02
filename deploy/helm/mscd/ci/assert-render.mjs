#!/usr/bin/env node
// Assertions on the output of `helm template` for the mscd chart (build plan J.1, I.4).
//
//   node deploy/helm/mscd/ci/assert-render.mjs [--secrets-create] <rendered.yaml>
//
// --secrets-create says the render used secrets.create: true (values-ci.yaml), so Secret objects are expected.
// Checks:
//   - the migrate Job is a pre-install,pre-upgrade hook with weight -5, backoffLimit 1, ttlSecondsAfterFinished 3600,
//     and mounts only the migrate Secret;
//   - every container (init containers included) runs with runAsNonRoot, a read-only root filesystem, no privilege
//     escalation, capabilities drop [ALL] and the RuntimeDefault seccomp profile;
//   - a default-deny NetworkPolicy covers every pod of the release, and the api accepts ingress only from web pods
//     (port 3000), apart from an explicit metrics rule on 9464;
//   - no Secret is rendered unless secrets.create is true; with it, one Secret per component, storage.key only in
//     the gateway Secret and platform.key never there;
//   - api and worker pods never mount the gateway Secret, the gateway pod never mounts the api (or worker) Secret,
//     and each component mounts only its own Secret and its own certificate;
//   - automountServiceAccountToken is false on every ServiceAccount and pod;
//   - the api trusts proxies by address range only, the web pods get the ingress ranges, and the Ingress routes to
//     the web Service only.
import { readFileSync } from 'node:fs';
import { parseAllDocuments, parse as parseYaml } from 'yaml';

const args = process.argv.slice(2);
const secretsCreate = args.includes('--secrets-create');
const files = args.filter((a) => !a.startsWith('--'));
if (files.length !== 1) {
  process.stderr.write('usage: assert-render.mjs [--secrets-create] <rendered.yaml>\n');
  process.exit(2);
}
const file = files[0];

const failures = [];
let checks = 0;
function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

const objects = [];
for (const doc of parseAllDocuments(readFileSync(file, 'utf8'))) {
  if (doc.errors.length > 0) {
    process.stderr.write(`${file}: YAML error: ${doc.errors[0].message}\n`);
    process.exit(1);
  }
  const value = doc.toJS();
  if (value && typeof value === 'object') objects.push(value);
}
const byKind = (kind) => objects.filter((o) => o.kind === kind);
const nameOf = (o) => `${o.kind}/${o.metadata?.name}`;
const componentOf = (labels) => labels?.['app.kubernetes.io/component'];

/** Pod specs with their owner, component and labels. */
const pods = [];
for (const o of objects) {
  let spec;
  let labels;
  if (o.kind === 'Pod') {
    spec = o.spec;
    labels = o.metadata?.labels;
  } else if (['Deployment', 'StatefulSet', 'DaemonSet', 'Job'].includes(o.kind)) {
    spec = o.spec?.template?.spec;
    labels = o.spec?.template?.metadata?.labels;
  } else if (o.kind === 'CronJob') {
    spec = o.spec?.jobTemplate?.spec?.template?.spec;
    labels = o.spec?.jobTemplate?.spec?.template?.metadata?.labels;
  }
  if (spec) pods.push({ owner: nameOf(o), object: o, spec, labels: labels ?? {}, component: componentOf(labels) });
}
check(pods.length > 0, 'no pod templates rendered');

/** Secret names a pod reads: volumes, projected sources, env and envFrom. */
function secretsOf(spec) {
  const names = new Set();
  for (const v of spec.volumes ?? []) {
    if (v.secret?.secretName) names.add(v.secret.secretName);
    for (const s of v.projected?.sources ?? []) if (s.secret?.name) names.add(s.secret.name);
  }
  for (const c of [...(spec.containers ?? []), ...(spec.initContainers ?? [])]) {
    for (const e of c.env ?? []) if (e.valueFrom?.secretKeyRef?.name) names.add(e.valueFrom.secretKeyRef.name);
    for (const e of c.envFrom ?? []) if (e.secretRef?.name) names.add(e.secretRef.name);
  }
  return names;
}

// Release full name: the api Deployment is <fullname>-api.
const apiDeployment = byKind('Deployment').find((d) => componentOf(d.metadata?.labels) === 'api');
check(apiDeployment, 'no api Deployment');
const fullname = apiDeployment ? apiDeployment.metadata.name.replace(/-api$/, '') : 'mscd';
for (const component of ['web', 'api', 'worker', 'gateway']) {
  check(
    byKind('Deployment').some((d) => componentOf(d.metadata?.labels) === component),
    `no ${component} Deployment`,
  );
}

// 1. The migrate hook.
const migrateJobs = byKind('Job').filter((j) => componentOf(j.metadata?.labels) === 'migrate');
check(migrateJobs.length === 1, `expected one migrate Job, found ${migrateJobs.length}`);
for (const job of migrateJobs) {
  const a = job.metadata.annotations ?? {};
  check(a['helm.sh/hook'] === 'pre-install,pre-upgrade', `${nameOf(job)}: helm.sh/hook is "${a['helm.sh/hook']}", expected "pre-install,pre-upgrade"`);
  check(String(a['helm.sh/hook-weight']) === '-5', `${nameOf(job)}: helm.sh/hook-weight is "${a['helm.sh/hook-weight']}", expected "-5"`);
  check(job.spec?.backoffLimit === 1, `${nameOf(job)}: backoffLimit is ${job.spec?.backoffLimit}, expected 1`);
  check(job.spec?.ttlSecondsAfterFinished === 3600, `${nameOf(job)}: ttlSecondsAfterFinished is ${job.spec?.ttlSecondsAfterFinished}, expected 3600`);
  const args = job.spec?.template?.spec?.containers?.[0]?.args ?? [];
  check(args.includes('migrate'), `${nameOf(job)}: the container does not run "migrate"`);
  const mounted = [...secretsOf(job.spec.template.spec)];
  check(mounted.length === 1, `${nameOf(job)}: mounts Secrets [${mounted.join(', ')}], expected only the migrate Secret`);
}

// 2. Container hardening.
for (const pod of pods) {
  const podSc = pod.spec.securityContext ?? {};
  for (const c of [...(pod.spec.containers ?? []), ...(pod.spec.initContainers ?? [])]) {
    const sc = c.securityContext ?? {};
    const where = `${pod.owner} container ${c.name}`;
    check((sc.runAsNonRoot ?? podSc.runAsNonRoot) === true, `${where}: runAsNonRoot is not true`);
    check(sc.readOnlyRootFilesystem === true, `${where}: readOnlyRootFilesystem is not true`);
    check(sc.allowPrivilegeEscalation === false, `${where}: allowPrivilegeEscalation is not false`);
    const drop = sc.capabilities?.drop ?? [];
    check(drop.length === 1 && drop[0] === 'ALL', `${where}: capabilities.drop is [${drop.join(', ')}], expected [ALL]`);
    check(!(sc.capabilities?.add ?? []).length, `${where}: adds capabilities`);
    check((sc.seccompProfile?.type ?? podSc.seccompProfile?.type) === 'RuntimeDefault', `${where}: seccompProfile.type is not RuntimeDefault`);
    check(sc.privileged !== true, `${where}: privileged`);
    check(sc.runAsUser !== 0 && podSc.runAsUser !== 0, `${where}: runs as user 0`);
  }
  check(pod.spec.hostNetwork !== true && pod.spec.hostPID !== true && pod.spec.hostIPC !== true, `${pod.owner}: uses a host namespace`);
}

// 3. NetworkPolicies.
const policies = byKind('NetworkPolicy');
const selects = (selector, labels) =>
  Object.entries(selector?.matchLabels ?? {}).every(([k, v]) => labels[k] === v) && !(selector?.matchExpressions ?? []).length;
const defaultDeny = policies.filter(
  (p) =>
    (p.spec?.policyTypes ?? []).includes('Ingress') &&
    (p.spec?.policyTypes ?? []).includes('Egress') &&
    !(p.spec?.ingress ?? []).length &&
    !(p.spec?.egress ?? []).length,
);
check(defaultDeny.length > 0, 'no default-deny NetworkPolicy (Ingress and Egress, no rules)');
for (const pod of pods) {
  check(
    defaultDeny.some((p) => selects(p.spec.podSelector, pod.labels)),
    `${pod.owner}: not covered by a default-deny NetworkPolicy`,
  );
}
const apiPod = pods.find((p) => p.component === 'api');
const webPod = pods.find((p) => p.component === 'web');
const apiPolicies = apiPod ? policies.filter((p) => selects(p.spec?.podSelector, apiPod.labels)) : [];
const apiIngressRules = apiPolicies.flatMap((p) => ((p.spec?.policyTypes ?? []).includes('Ingress') ? (p.spec.ingress ?? []).map((r) => ({ policy: nameOf(p), rule: r })) : []));
check(apiIngressRules.length > 0, 'the api has no ingress rule (the web pods must reach it)');
let webRule = false;
for (const { policy, rule } of apiIngressRules) {
  const ports = (rule.ports ?? []).map((p) => p.port);
  const metricsOnly = ports.length > 0 && ports.every((p) => p === 9464 || p === 'metrics');
  if (metricsOnly && (rule.from ?? []).length > 0) continue;
  const from = rule.from ?? [];
  const onlyWeb =
    from.length > 0 &&
    from.every((peer) => peer.podSelector && !peer.namespaceSelector && !peer.ipBlock && webPod && selects(peer.podSelector, webPod.labels) && componentOf(peer.podSelector.matchLabels) === 'web');
  check(onlyWeb, `${policy}: an api ingress rule allows sources other than the web pods: ${JSON.stringify(rule)}`);
  check(ports.length > 0 && ports.every((p) => p === 3000 || p === 'http'), `${policy}: the web rule of the api is not limited to port 3000`);
  if (onlyWeb) webRule = true;
}
check(webRule, 'no NetworkPolicy lets the web pods reach the api');

// 4. Secrets.
const secrets = byKind('Secret');
if (!secretsCreate) {
  check(secrets.length === 0, `Secrets rendered without secrets.create: ${secrets.map((s) => s.metadata.name).join(', ')}`);
} else {
  for (const component of ['api', 'worker', 'gateway', 'migrate']) {
    check(secrets.some((s) => s.metadata.name === `${fullname}-${component}`), `no Secret ${fullname}-${component}`);
  }
  for (const s of secrets) {
    const keys = Object.keys({ ...(s.data ?? {}), ...(s.stringData ?? {}) });
    if (s.metadata.name === `${fullname}-gateway`) {
      check(keys.includes('storage.key'), `${nameOf(s)}: no storage.key`);
      check(!keys.includes('platform.key'), `${nameOf(s)}: holds platform.key`);
    } else {
      check(!keys.includes('storage.key'), `${nameOf(s)}: holds storage.key (only the gateway Secret may)`);
    }
  }
}

// 5. Secret mounts per component.
const mountsOf = (component) => {
  const names = new Set();
  for (const pod of pods.filter((p) => p.component === component)) for (const n of secretsOf(pod.spec)) names.add(n);
  return names;
};
const own = (component) => [`${fullname}-${component}`, `${fullname}-${component}-tls`];
const gatewaySecret = `${fullname}-gateway`;
const apiSecret = `${fullname}-api`;
const workerSecret = `${fullname}-worker`;
for (const component of ['api', 'worker']) {
  const mounted = mountsOf(component);
  check(!mounted.has(gatewaySecret) && !mounted.has(`${gatewaySecret}-tls`), `${component} pods mount the gateway Secret`);
}
const gatewayMounts = mountsOf('gateway');
check(!gatewayMounts.has(apiSecret) && !gatewayMounts.has(workerSecret), 'the gateway pod mounts the api or worker Secret');
for (const component of ['api', 'worker', 'gateway']) {
  const mounted = [...mountsOf(component)];
  check(mounted.includes(`${fullname}-${component}`), `${component} pods do not mount ${fullname}-${component}`);
  check(mounted.every((n) => own(component).includes(n)), `${component} pods mount Secrets of other components: ${mounted.join(', ')}`);
}
check(mountsOf('web').size === 0 || [...mountsOf('web')].every((n) => !n.startsWith(`${fullname}-`)), 'web pods mount a component Secret');

// 6. Service account tokens.
for (const sa of byKind('ServiceAccount')) {
  check(sa.automountServiceAccountToken === false, `${nameOf(sa)}: automountServiceAccountToken is not false`);
}
for (const pod of pods) {
  check(pod.spec.automountServiceAccountToken === false, `${pod.owner}: automountServiceAccountToken is not false`);
}

// 7. Proxies and routing.
const profileMap = byKind('ConfigMap').find((c) => c.metadata.name === `${fullname}-profile`);
check(profileMap, `no ConfigMap ${fullname}-profile`);
if (profileMap) {
  const profile = parseYaml(profileMap.data['profile.yaml']);
  const tp = profile?.http?.trust_proxy ?? {};
  check(Array.isArray(tp.cidrs) && tp.cidrs.length > 0 && !('hops' in tp), `profile http.trust_proxy is ${JSON.stringify(tp)}, expected {cidrs: [...]}`);
  check(profile?.gateway?.kms?.file?.path === '/run/secrets/storage.key', 'profile gateway.kms.file.path is not /run/secrets/storage.key');
  const migrateMap = byKind('ConfigMap').find((c) => c.metadata.name === `${fullname}-migrate-profile`);
  check(migrateMap?.data?.['profile.yaml'] === profileMap.data['profile.yaml'], 'the migrate profile differs from the profile of the pods');
}
if (webPod) {
  const env = Object.fromEntries((webPod.spec.containers[0].env ?? []).map((e) => [e.name, e.value]));
  check('MSCD_TRUSTED_PROXY_CIDRS' in env, 'web pods get no MSCD_TRUSTED_PROXY_CIDRS');
  check(/^[^:]+-api\.[^:]+:3000$/.test(env.MSCD_API_UPSTREAM ?? ''), `web MSCD_API_UPSTREAM is "${env.MSCD_API_UPSTREAM}"`);
}
for (const ing of byKind('Ingress')) {
  for (const rule of ing.spec?.rules ?? []) {
    const paths = rule.http?.paths ?? [];
    check(paths.some((p) => p.path === '/api') && paths.some((p) => p.path === '/'), `${nameOf(ing)}: host ${rule.host} does not route / and /api`);
    for (const p of paths) {
      check(p.backend?.service?.name === `${fullname}-web`, `${nameOf(ing)}: ${p.path} routes to ${p.backend?.service?.name}, not the web Service`);
    }
  }
}
for (const svc of byKind('Service')) {
  if (['api', 'gateway'].includes(componentOf(svc.metadata?.labels))) {
    check((svc.spec?.type ?? 'ClusterIP') === 'ClusterIP', `${nameOf(svc)}: type ${svc.spec?.type}, expected ClusterIP`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`assert-render: ${file}: ${failures.length} of ${checks} checks failed\n`);
  for (const f of failures) process.stderr.write(`  - ${f}\n`);
  process.exit(1);
}
process.stdout.write(`assert-render: ${file}: ${checks} checks passed (${objects.length} objects)\n`);
