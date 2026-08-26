import { defineConfig } from 'vitest/config';

// Config dedicada dos testes de LÓGICA do renderer (Fase B+). Propositalmente
// NÃO carrega o vite.config (plugin react etc.) — assim o CI roda os testes só
// com o vitest instalado, sem o toolchain inteiro. Testes de componente (jsdom)
// entram depois num projeto separado.
export default defineConfig({
  test: {
    include: ['renderer/src/**/*.test.ts'],
    environment: 'node',
  },
});
