// Status de pagamento das parcelas (1 e 2) de UMA célula — o líder, os
// multiplicadores ativos e o(s) veículo(s) do líder —, para a tela Gestão de
// Líderes (plataforma principal e Painel de Consulta).
//
// Lógica pura: recebe a célula e um ÍNDICE de pagamentos já efetuados.
// "Parcela paga" segue o mesmo critério da Agenda (lib/parcelasPessoal.js):
// consumo em ordem — o n-ésimo pagamento de uma pessoa/placa quita a n-ésima
// parcela do cronograma dela. Quem está fora da Agenda (inativo, não gera
// pagamento, veículo sem valor) não entra na conta.
//
// Cópia idêntica em painel-consulta/statusPagamentoCelula.js (deploy
// isolado; test/statusPagamentoCelula.test.js garante que continuam iguais).
// Depende de ParcelasPessoal (lib/parcelasPessoal.js, também copiado lá).
//
// UMD: window.StatusPagamentoCelula no navegador, require() nos testes.
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./parcelasPessoal'));
    else root.StatusPagamentoCelula = factory(root.ParcelasPessoal);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PP) {
    'use strict';

    const PARCELAS_EXIBIDAS = [1, 2];
    const LOCAL_COMITE = 'Comitê';

    const ehAtivo = v => v === undefined || v === null ? true : !!v;

    // Índice { pessoas: Map<id, nº de pagamentos>, veiculos: Map<placa, nº> }
    // a partir dos lançamentos (mesmas regras de ParcelasPessoal.
    // pagamentosDaPessoa / pagamentosDoVeiculo, numa passada só — a tela
    // consulta milhares de pessoas e os consolidados têm milhares de itens).
    function indexarPagamentos(lancamentos) {
        const pessoas = new Map();
        const veiculos = new Map();
        const somar = (mapa, chave) => mapa.set(chave, (mapa.get(chave) || 0) + 1);
        (lancamentos || []).forEach(l => {
            if (l.tipo !== 'DESPESA') return;
            const ehAluguel = PP.TIPIFICACOES_VEICULO.has(l.tipificacao);
            if (l.pessoa_id != null) somar(pessoas, String(l.pessoa_id));
            if (l.placa != null && ehAluguel) somar(veiculos, l.placa);
            if (l.pessoa_id != null) return;
            PP.normalizarDetalhePagamentos(l.detalhe_pagamentos).forEach(d => {
                if (!d) return;
                if (d.pessoa_id != null) somar(pessoas, String(d.pessoa_id));
                if (d.placa != null && ehAluguel) somar(veiculos, d.placa);
            });
        });
        return { pessoas, veiculos };
    }

    // Mesmo índice, a partir de linhas já contadas — o formato que a RPC
    // gestao_lideres_pagamentos_realizados() devolve ao painel:
    // [{ pessoa_id, placa, pagamentos }] (uma das duas chaves preenchida).
    function indexarPagamentosContados(linhas) {
        const pessoas = new Map();
        const veiculos = new Map();
        (linhas || []).forEach(r => {
            const n = Number(r.pagamentos) || 0;
            if (r.pessoa_id != null) pessoas.set(String(r.pessoa_id), (pessoas.get(String(r.pessoa_id)) || 0) + n);
            else if (r.placa != null) veiculos.set(r.placa, (veiculos.get(r.placa) || 0) + n);
        });
        return { pessoas, veiculos };
    }

    function statusDoConjunto(total, pagos) {
        if (!total) return 'sem_valor';
        if (pagos >= total) return 'paga';
        return pagos > 0 ? 'parcial' : 'a_pagar';
    }

    const r2 = v => Math.round(v * 100) / 100;

    // Situação das parcelas 1 e 2 da célula do líder.
    //  → { situacao: 'ok' | 'inativa' | 'comite', parcelas: [...] }
    // Cada parcela: { parcela, data, total, pagos, valorTotal, valorPago,
    // status: 'paga' | 'parcial' | 'a_pagar' | 'sem_valor', pendentes: [rótulo] }.
    // 'inativa' = líder/célula fora da Agenda; 'comite' = o Comitê é pago em
    // bloco, sem detalhe por pessoa — nos dois casos não há status por parcela.
    function statusParcelasCelula(lider, multiplicadores, veiculos, indice) {
        if (!ehAtivo(lider.ativo) || !ehAtivo(lider.celula_ativa)) return { situacao: 'inativa', parcelas: [] };
        if (lider.local_prestacao === LOCAL_COMITE) return { situacao: 'comite', parcelas: [] };

        const idx = indice || { pessoas: new Map(), veiculos: new Map() };
        const itens = [];
        [lider, ...(multiplicadores || [])].forEach(p => {
            if (!ehAtivo(p.ativo) || p.nao_gerar_pagamento) return;
            itens.push({
                rotulo: p.nome,
                cronograma: PP.calcularCronogramaParcelasPessoal(p),
                pagamentos: idx.pessoas.get(String(p.id)) || 0
            });
        });
        (veiculos || []).forEach(v => {
            if (v.nao_gerar_pagamento || v.valor_contratado == null) return;
            itens.push({
                rotulo: `Veículo ${v.placa}`,
                cronograma: PP.calcularCronogramaParcelasVeiculo(v, lider),
                pagamentos: idx.veiculos.get(v.placa) || 0
            });
        });

        const parcelas = PARCELAS_EXIBIDAS.map(numero => {
            const r = { parcela: numero, data: null, total: 0, pagos: 0, valorTotal: 0, valorPago: 0, pendentes: [] };
            itens.forEach(item => {
                const c = item.cronograma.find(x => x.parcela === numero);
                if (!c) return;
                if (!r.data) r.data = c.data;
                r.total++;
                r.valorTotal += c.valor;
                if (item.pagamentos >= numero) { r.pagos++; r.valorPago += c.valor; }
                else r.pendentes.push(item.rotulo);
            });
            r.valorTotal = r2(r.valorTotal);
            r.valorPago = r2(r.valorPago);
            r.status = statusDoConjunto(r.total, r.pagos);
            return r;
        });
        return { situacao: 'ok', parcelas };
    }


    const ESTILO_STATUS = {
        paga:     { icone: '✅', rotulo: 'Paga',    cor: '#15803d', fundo: '#f0fdf4', borda: '#bbf7d0' },
        parcial:  { icone: '🟡', rotulo: 'Parcial', cor: '#b45309', fundo: '#fffbeb', borda: '#fde68a' },
        a_pagar:  { icone: '⏳', rotulo: 'A pagar', cor: '#b91c1c', fundo: '#fef2f2', borda: '#fecaca' },
        sem_valor:{ icone: '—',  rotulo: 'Sem valor', cor: '#64748b', fundo: '#f8fafc', borda: '#e2e8f0' }
    };

    const dataCurta = iso => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '';

    // Faixa HTML com o status de cada parcela (para o card da célula). fmt:
    // { escapar(texto), formatarMoeda(número) } — cada plataforma passa os
    // seus, para o lib não depender de nenhuma das duas telas.
    function htmlStatusCelula(resultado, fmt) {
        const { escapar, formatarMoeda } = fmt;
        const muted = texto => `<div class="text-muted" style="font-size:0.8rem; margin-top:0.5rem;">💳 Pagamento: ${escapar(texto)}</div>`;
        if (!resultado || resultado.situacao === 'inativa') return muted('célula inativa — fora da Agenda de Pagamento');
        if (resultado.situacao === 'comite') return muted('Comitê é pago em bloco, sem controle por pessoa');
        const caixas = resultado.parcelas.map(p => {
            const e = ESTILO_STATUS[p.status];
            const data = dataCurta(p.data);
            let detalhe = '';
            if (p.status === 'parcial') detalhe = ` ${p.pagos}/${p.total} · ${formatarMoeda(p.valorPago)} de ${formatarMoeda(p.valorTotal)}`;
            else if (p.status !== 'sem_valor') detalhe = ` · ${formatarMoeda(p.valorTotal)}`;
            const dica = p.pendentes.length ? 'Falta pagar: ' + p.pendentes.join(', ') : '';
            return `<div title="${escapar(dica)}" style="border:1px solid ${e.borda}; border-left:4px solid ${e.cor}; background:${e.fundo}; border-radius:8px; padding:0.4rem 0.75rem; font-size:0.85rem;">
                <strong>Parcela ${p.parcela}${data ? ' · ' + data : ''}</strong>
                <span style="color:${e.cor}; font-weight:700; margin-left:0.35rem;">${e.icone} ${e.rotulo}</span>${escapar(detalhe)}
            </div>`;
        });
        return `<div style="display:flex; gap:0.6rem; flex-wrap:wrap; margin-top:0.6rem;">${caixas.join('')}</div>`;
    }

    return { PARCELAS_EXIBIDAS, htmlStatusCelula, indexarPagamentos, indexarPagamentosContados, statusParcelasCelula };
});
