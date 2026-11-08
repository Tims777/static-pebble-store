import type Site from "lume/core/site.ts";
import { normalizePath } from "lume/core/utils/path.ts";
import { join } from "lume/deps/path.ts";
import { encodeHex } from "jsr:@std/encoding@1.0.10/hex";
import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
} from "jsr:@zip-js/zip-js@2.8.26";

const PLATFORMS = [
  "aplite",
  "basalt",
  "chalk",
  "diorite",
  "emery",
  "flint",
  "gabbro",
];
const IMAGE = /\.(gif|jpe?g|png|webp)$/i;
interface AppInfo {
  uuid?: string;
  sdkVersion?: string;
  versionLabel?: string;
  capabilities?: string[];
  watchapp?: { watchface?: boolean };
}
interface Metadata {
  title: string;
  author: string;
  category: string;
  description?: string;
  website?: string;
  source?: string;
  releaseNotes?: string;
  hearts?: number;
}
type App = Awaited<ReturnType<typeof readApp>>;

export default function pebbleStore(directory: string) {
  return (site: Site) => {
    const root = site.root(directory);
    const { title, host = site.options.location.href } =
      site.scopedData.get("/api") ?? {};
    const assets = new Map<string, string>();
    site.page({
      title,
      host,
      url: "/api",
      content: async function* ({ host }: { host: string }) {
        assets.clear();
        const apps: App[] = [];
        for await (const { folder, files } of discover(root)) {
          const relative = normalizePath(folder, root).slice(1);
          if (!relative) {
            throw new Error(
              "PBWs must be inside an app directory, not the catalog root.",
            );
          }
          const data =
            site.search.data(normalizePath(folder, site.src())) as Metadata ??
              {};
          const app = await readApp(folder, files, relative, host, data);
          apps.push(app);
          for (
            const file of files.filter((name) =>
              /\.pbw$/i.test(name) || IMAGE.test(name)
            )
          ) {
            assets.set(
              join(folder, file),
              site.dest(`assets/apps/${app.id}/${file}`),
            );
          }
        }
        for (const [url, response] of responses(apps, host)) {
          yield { url, content: `${JSON.stringify(response, null, 2)}\n` };
        }
      },
    });
    site.addEventListener("afterBuild", async () => {
      for (const [source, destination] of assets) {
        await Deno.mkdir(join(destination, ".."), { recursive: true });
        await Deno.copyFile(source, destination);
      }
    });
  };
}

async function* discover(
  folder: string,
): AsyncGenerator<{ folder: string; files: string[] }> {
  const entries = (await Array.fromAsync(Deno.readDir(folder))).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const files = entries.filter((entry) => entry.isFile).map((entry) =>
    entry.name
  );
  const pbws = files.filter((name) => /\.pbw$/i.test(name));
  if (pbws.length > 1) {
    throw new Error(`${folder} must contain exactly one PBW.`);
  }
  if (pbws.length) {
    yield { folder, files };
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory && !/^[_.]/.test(entry.name)) {
      yield* discover(join(folder, entry.name));
    }
  }
}

async function stableId(value: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return encodeHex(hash).slice(0, 24);
}

async function readBundle(path: string) {
  const reader = new Uint8ArrayReader(await Deno.readFile(path));
  const zip = new ZipReader(reader, { useWebWorkers: false });
  try {
    const entries = new Map(
      (await zip.getEntries()).map((entry) => [entry.filename, entry]),
    );
    const bytes = async (name: string) => {
      const entry = entries.get(name);
      if (!entry || entry.directory) {
        throw new Error(`${path} is missing ${name}.`);
      }
      return await entry.getData(new Uint8ArrayWriter(), {
        checkSignature: true,
      });
    };
    const json = async (name: string) =>
      JSON.parse(new TextDecoder().decode(await bytes(name)));
    const info: AppInfo = await json("appinfo.json");
    if (!info.uuid) throw new Error(`${path} has no app UUID.`);
    const hardware: Record<
      string,
      { sdk: string; flags: number; icon: number }
    > = {};
    let timestamp = 0;
    for (const platform of PLATFORMS) {
      if (!entries.has(`${platform}/manifest.json`)) continue;
      const { generatedAt, application } = await json(
        `${platform}/manifest.json`,
      );
      timestamp = Math.max(
        timestamp,
        generatedAt ?? 0,
        application?.timestamp ?? 0,
      );
      const binary = await bytes(`${platform}/${application?.name}`);
      // Pebble's PBLAPP header: SDK at 10, icon resource at 88, process flags at 96.
      if (
        binary.length < 120 ||
        new TextDecoder().decode(binary.subarray(0, 8)) !== "PBLAPP\0\0"
      ) {
        throw new Error(`${path}: invalid ${platform} PBLAPP header.`);
      }
      const view = new DataView(
        binary.buffer,
        binary.byteOffset,
        binary.byteLength,
      );
      hardware[platform] = {
        sdk: `${view.getUint8(10)}.${view.getUint8(11)}`,
        flags: view.getUint32(96, true),
        icon: view.getUint32(88, true),
      };
    }
    const published_date = timestamp
      ? new Date(timestamp * 1000).toISOString()
      : null;
    return { info, hardware, published_date };
  } finally {
    await zip.close();
  }
}

async function readApp(
  folder: string,
  files: string[],
  relative: string,
  host: string,
  data: Metadata,
) {
  const pbw = files.find((name) => /\.pbw$/i.test(name))!;
  const { info, hardware, published_date } = await readBundle(
    join(folder, pbw),
  );
  const id = await stableId(`app:${relative}`);
  const asset = (name: string) =>
    new URL(`assets/apps/${id}/${name}`, host).href;
  const images = files.filter((name) => IMAGE.test(name));
  const icon = images.find((name) => /^(icon|logo)/i.test(name));
  const preferred = images.filter((name) =>
    /^(preview|screen|screenshot)/i.test(name)
  );
  const screenshots =
    (preferred.length ? preferred : images.filter((name) => name !== icon)).map(
      asset,
    );
  const iconUrl = icon ? asset(icon) : screenshots[0] ?? "";
  const platforms = Object.keys(hardware);
  if (!platforms.length) {
    throw new Error(`${folder} has no supported hardware platforms.`);
  }
  const { category, description = "" } = data;
  if (typeof category !== "string" || !/^[A-Za-z0-9_-]+$/.test(category)) {
    throw new Error(
      `${folder}: category must contain only letters, digits, underscores or hyphens.`,
    );
  }
  const { versionLabel: version = null } = info;
  const release = {
    version,
    published_date,
    release_notes: data.releaseNotes ?? null,
  };
  return {
    id,
    author: data.author,
    description,
    category,
    published_date,
    title: data.title,
    uuid: info.uuid,
    type: info.watchapp?.watchface ? "watchface" : "watchapp",
    category_id: await stableId(`category:${category}`),
    category_color: "808080",
    capabilities: info.capabilities,
    changelog: [release],
    companions: { android: null, ios: null },
    compatibility: {
      ...Object.fromEntries(PLATFORMS.map((name) => [name, {
        supported: platforms.includes(name),
        firmware: { major: Number.parseInt(info.sdkVersion ?? "3", 10) || 3 },
      }])),
      android: { supported: true },
      ios: { supported: true, min_js_version: 1 },
    },
    hardware_platforms: platforms.map((name) => ({
      name,
      description,
      sdk_version: hardware[name].sdk,
      pebble_process_info_flags: hardware[name].flags,
      images: {
        icon: iconUrl,
        list: iconUrl,
        screenshot: screenshots[0] ?? iconUrl,
      },
    })),
    created_at: published_date ?? "",
    developer_id: await stableId(`developer:${data.author}`),
    header_images: [],
    hearts: data.hearts ?? 0,
    icon_image: { "28x28": iconUrl, "48x48": iconUrl },
    latest_release: {
      ...release,
      id: await stableId(`release:${id}:${release.version}`),
      js_md5: null,
      js_version: -1,
      pbw_file: asset(pbw),
    },
    links: {},
    list_image: { "144x144": iconUrl, "80x80": iconUrl },
    screenshot_hardware: platforms[0],
    screenshot_images: screenshots.map((url) => ({ "144x168": url })),
    source: data.source ?? null,
    website: data.website ?? null,
    visible: true,
    icon_resource_id: hardware[platforms[0]].icon,
  };
}

function collection(data: App[]) {
  return { data, limit: data.length, offset: 0, links: { nextPage: null } };
}
function* responses(apps: App[], host: string): Generator<[string, unknown]> {
  const groups = Map.groupBy(apps, (app) => app.category_id);
  apps.sort((a, b) => a.title.localeCompare(b.title));
  // Mobileapp filters this static bulk response to the IDs it requested.
  yield ["/api/v1/apps/bulk", { data: apps }];
  const categories = [...groups].map(([id, members]) => {
    const { category: name, category_color: color } = members[0];
    return {
      id,
      name,
      slug: name,
      color,
      application_ids: members.map((app) => app.id),
      icon: { "88x88": "" },
      links: { apps: new URL(`api/v1/apps/category/${name}`, host).href },
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  for (const app of apps) {
    yield [`/api/v1/apps/id/${app.id}`, collection([app])];
  }
  for (const category of categories) {
    yield [
      `/api/v1/apps/category/${category.slug}`,
      collection(apps.filter((app) => app.category_id === category.id)),
    ];
  }
  const collections = [
    ["faces", "watchface", "All Watchfaces"],
    ["apps", "watchapp", "All Watchapps"],
  ];
  for (const [slug, type, name] of collections) {
    const applications = apps.filter((app) => app.type === type);
    const collectionUrl = `/api/v1/apps/collection/all/${slug}`;
    yield [collectionUrl, collection(applications)];
    yield [`/api/v1/home/${slug}`, {
      applications,
      categories: categories.filter((category) =>
        applications.some((app) => app.category_id === category.id)
      ),
      collections: [{
        name,
        slug: "all",
        application_ids: applications.map((app) => app.id),
        links: { apps: new URL(collectionUrl.slice(1), host).href },
      }],
    }];
  }
}
