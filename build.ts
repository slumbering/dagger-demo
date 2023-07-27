import Client, { connect } from "@dagger.io/dagger"

// initialize Dagger client
connect(async (client: Client) => {
  // Set Node versions against which to test and build
  const target = process.argv[2];
  // get reference to the local project
  client = client.pipeline(target)
  const source = client.host().directory(".", { exclude: ["node_modules/"] })

    // mount cloned repository into Node image
    const runner = client
      .container().from(`node:16`)
      .withDirectory("/src", source)
      .withWorkdir("/src")
      .withExec(["npm", "install"])

    if (target === 'test') {
      // run tests
      // write the test output to the host
      await runner.withExec(["npm", "test", "--", "--watchAll=false"]).sync()
    } else if (target === 'build') {
      await runner
        .withExec(["npm", "run", "build"])
        .directory("build/")
        .export(`./build-node-16`)
    }
}, { LogOutput: process.stdout })
