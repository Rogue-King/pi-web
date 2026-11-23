# Release Checklist

`@rogue-king/pi-web` follows upstream’s npm release model: build from source, then publish the package with `.next/` inside it. Do not commit `.next/` or publish from a checkout that has run the app. Use a clean checkout of the `magi` branch.

## First publication

Log in to npm as a maintainer with publish access to `@rogue-king`. The package needs to exist before you can configure its Trusted Publisher:

```bash
npm login --registry=https://registry.npmjs.org/
npm ci --include=dev
npm test
npm run build
npm pack
npm publish ./rogue-king-pi-web-0.18.1.tgz --access public
```

On npmjs.com, open `@rogue-king/pi-web` → Settings → Trusted Publishing and add GitHub Actions:

- Organization or user: `Rogue-King`
- Repository: `pi-web`
- Workflow filename: `publish.yml`
- Environment: leave empty
- Permission: `npm publish`

Configure this when the next release is ready to push: npm expires a new connection if its first successful CI publication does not happen within two days. Do not push a release tag to republish the manually published version.

## Subsequent releases

Verify the checkout and tests, then bump the version and push only the new tag:

```bash
git status --short --branch
npm ci --include=dev
npm test
npm run release                  # patch release; creates a version commit and tag
git push origin magi v<version>
```

`.github/workflows/publish.yml` checks that the tag matches the package version, runs `npm ci --include=dev` and `npm run build`, then publishes to npm with OIDC. No npm token is needed in GitHub. After publishing, create the GitHub Release for the tag so the in-app release link works.

Confirm the version with `npm view @rogue-king/pi-web@<version> version`. Magi can then fetch a compatible release with `bun update @rogue-king/pi-web` once it declares the dependency.
