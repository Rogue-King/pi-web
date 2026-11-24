# Release Checklist

The [release workflow](../.github/workflows/publish.yml) runs when a matching stable version tag is pushed from `magi`. It tests and builds from a clean checkout, then publishes the verified npm tarball with `.next/` inside. Do not commit the build output.

## First publication

For the first release of `@rogue-king/pi-web`, create a **new**, short-lived npm granular access token with write access to the `@rogue-king` scope and bypass 2FA enabled for CI. Save it as the `NPM_TOKEN` Actions secret in `Rogue-King/pi-web`. Do not put it in Git or paste it into chat. If Actions are disabled on the fork, enable them in its Actions tab.

When `magi` contains the release workflow and is at version `0.18.1`, tag and push that checked-out commit:

```bash
git tag -a v0.18.1 -m "Release v0.18.1"
git push origin magi refs/tags/v0.18.1
```

## Subsequent releases

On npmjs.com, open `@rogue-king/pi-web` → Settings → Trusted Publishing and add GitHub Actions:

- Organization or user: `Rogue-King`
- Repository: `pi-web`
- Workflow filename: `publish.yml`
- Environment: leave empty
- Permission: `npm publish`

Delete the `NPM_TOKEN` Actions secret and revoke the bootstrap token. Configure Trusted Publishing when the next release is ready: npm expires a new connection if its first successful CI publication does not happen within two days.

From a clean `magi` checkout:

```bash
npm run release                  # patch release; creates a version commit and tag
git push origin magi refs/tags/v<version>
```

Confirm publication with `npm view @rogue-king/pi-web@<version> version`. Create a GitHub Release for the tag if you want the in-app release link to show release notes.
