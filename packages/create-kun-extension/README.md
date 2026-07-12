# create-kun-extension

Create an atomic, least-privilege Kun extension project:

```sh
npx create-kun-extension my-extension \
  --template react \
  --publisher acme \
  --name issue-assistant
```

Templates: `node`, `webview`, and `react`. Every generated project includes
build, test, `kun extension validate`, and `kun extension pack` scripts.
