<script>
  import { onMount } from "svelte";
  import { start } from "./lib/store.svelte.js";
  import Header from "./components/Header.svelte";
  import Notice from "./components/Notice.svelte";
  import Lobby from "./components/Lobby.svelte";
  import Recent from "./components/Recent.svelte";
  import Formula from "./components/Formula.svelte";

  onMount(start);
</script>

<main class="app">
  <Header />
  <Notice />
  <Lobby />
  <Recent />
  <Formula />
</main>
