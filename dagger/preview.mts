import Client, { Container, Platform, Secret, connect } from "@dagger.io/dagger"
import { join } from 'path';
import { execSync } from 'child_process';
import * as path from "path";
import * as url from "url";
import { Octokit } from "@octokit/action";

// https://hub.docker.com/_/node
const nodeJSVersion = "16"
// https://hub.docker.com/r/flyio/flyctl/tags
const flyctlVersion = "0.1.62"
// https://fly.io/dashboard/dagger
const flyOrg = "dagger"
// this sounds excessive,
// but the default 256MB resulted in OOM app crashes 🤷
const appMemoryMB = "512"
// https://fly.io/docs/reference/configuration/#picking-a-deployment-strategy
const deployStrategy = "bluegreen"
// wait this many seconds for the app to finish deploying
const waitSeconds = "120"

const containerPlatform = "linux/amd64" as Platform

function flyTokenSecret(c: Client): Secret {
	const flyToken = process.env.FLY_API_TOKEN
	if (!flyToken) {
		throw new Error("FLY_API_TOKEN env var must be set")
	}
	return c.setSecret("FLY_API_TOKEN", flyToken)
}

function githubRef(): string {
	const githubHeadRef = process.env.GITHUB_HEAD_REF
	if (!githubHeadRef) {
		throw new Error("GITHUB_HEAD_REF env var must be set")
	}

	return githubHeadRef.replace(/[^a-zA-Z0-9-.]/g, "-"); 
}

function flyctl(c: Client) {
	c = c.pipeline("flyctl")
	const flyctl = c.container({platform: containerPlatform}).pipeline("auth")
		.from(`flyio/flyctl:v${flyctlVersion}`)
		.withSecretVariable("FLY_API_TOKEN", flyTokenSecret(c))
		.withEnvVariable("RUN_AT", Date.now().toString())
		.withNewFile("fly.toml", {
			contents: `# https://fly.io/docs/reference/configuration/
app = "dagger-cloud-${githubRef()}"

[processes]
	app = "yarn start"

[http_service]
	processes = ["app"]
	internal_port = 3000
	force_https = true

[[http_service.checks]]
	interval = "10s"
	timeout = "9s"
	method = "GET"
	path = "/"`,
		})

	return flyctl
}

// Install and build the app
function app(c: Client): Container {
	const workdir = path.dirname(url.fileURLToPath(`${import.meta.url}/../..`))

	if (!workdir) {
		throw new Error("workdir must be set")
	}
	const src = join(workdir, "app", "cloud");
	const node = c.container({platform: containerPlatform}).from(`node:${nodeJSVersion}`)
	const yarnCache = `/usr/local/share/.cache/yarn/${nodeJSVersion}`
	const yarnCacheVolume = `dagger-cloud-yarn-${nodeJSVersion}`

	const app = node.pipeline("app")
		.withDirectory("/app", c.host().directory(src, { exclude: ["node_modules, .next"] }))
		.withMountedCache(yarnCache, c.cacheVolume(yarnCacheVolume))
		.withEnvVariable("YARN_CACHE_FOLDER", yarnCache)
		.withWorkdir("/app")
		.withExec(["yarn", "install"])
		.withEnvVariable("NEXT_PUBLIC_API_URL", "https://api.dagger.cloud/query")
		.withEnvVariable("NEXT_PUBLIC_API_ORIGIN_URL", "https://api.dagger.cloud")
		.withExec(["yarn", "build"])

	return app
}

// Get the git SHA
function gitSHA(): string {
	let gitSHA = process.env.GITHUB_SHA
	if (!gitSHA) {
		try {
			let gitHEAD = execSync('git rev-parse HEAD').toString().trim();
			gitSHA = `${gitHEAD}.`;
		} catch (err) {
			console.error(err);
		}
		gitSHA = `${gitSHA}.dev`;
	}

	return gitSHA
}

function getGihubContext() {
	if(!process.env.GITHUB_REPOSITORY || !process.env.GITHUB_PR_NUMBER) {
		throw new Error("Error while retrieving github context")
	}
	const githubRepository = process.env.GITHUB_REPOSITORY;
	const [ owner, repo ] = githubRepository.split("/");
  const prNumber = process.env.GITHUB_PR_NUMBER as unknown as number;

	return {
		owner,
		repo,
		prNumber,
	}
}

async function createGithubComment(comment: string) {
	const { owner, repo, prNumber } = getGihubContext();

	const octokit = new Octokit();

	const {data} = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    owner,
    repo,
    issue_number: prNumber,
    body: `Deploy preview: ${comment}`
  });

	console.log("🐞 --------------🐞")
	console.log("🐞  data:", data)
	console.log("🐞 --------------🐞")

}

// Create Dagger client
export function createClient() {
	return connect(
		async (client: Client) => {
			createGithubComment("https://dagger.cloud");
			// 	try {
			// 		await flyctl(client).withExec(["status"]).sync()
			// 	} catch (error) {
			// 		try {
			// 			await flyctl(client)
			// 				.withExec(["apps", "create", `dagger-cloud-${githubRef()}`, "--org", flyOrg]).sync()
			// 		} catch (error) {
			// 			console.error(error)
			// 		}
			// 	}

			// const exportTarball = process.env.EXPORT
			// if (exportTarball) {
			// 	await app(client).export("tmp/app.tar")
			// 	console.log("STOPPING FOR LOCAL DEBUGGING, e.g. docker load -i tmp/app.tar")
			// 	process.exit(0)
			// }

			// const appImageRef = await app(client)
			// 	.withRegistryAuth("registry.fly.io", "x", flyTokenSecret(client))
			// 	.publish(`registry.fly.io/dagger-cloud-${githubRef()}:${gitSHA()}`)

			// await flyctl(client).pipeline("deploy")
			// 	.withExec(["deploy", "--now", "--app", `dagger-cloud-${githubRef()}`, "--image", appImageRef, "--vm-memory", appMemoryMB, "--ha=false", "--strategy", deployStrategy, "--wait-timeout", waitSeconds])
			// 	.sync()
		}, { LogOutput: process.stdout }
	)
}

export function destroyClient() {
	return connect(
		async (client: Client) => {
			try {
				await flyctl(client).pipeline("destroy").
				withExec(["apps", "destroy", `dagger-cloud-${githubRef()}`, "--yes"]).
				sync()
			} catch (error) {
				console.error(error)
			}
		}, { LogOutput: process.stderr }
	)
}