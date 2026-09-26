// Regras de atividade de pessoas e células (Gestão de Líderes / Agenda de
// Pagamento).
//
//   - pessoal_contratado.ativo         — pessoa ativa (default true). Uma
//     pessoa inativa some da Agenda de Pagamento.
//   - pessoal_contratado.celula_ativa  — só faz sentido no líder: célula
//     ativa (default true). Célula inativa tira da Agenda o líder, os
//     multiplicadores dele e os veículos cedidos por ele.
//
// Ambas as flags são opt-out: undefined/null (linha antiga, coluna ainda não
// migrada) conta como ativo.
//
// UMD: usado pelo app.js/painel (window.AtividadeCelula), pelo servidor
// (snapshot público de pagamentos) e pelos testes.
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.AtividadeCelula = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const ehAtivo = valor => valor === undefined || valor === null ? true : !!valor;

    function pessoaAtiva(p) {
        return !!p && ehAtivo(p.ativo);
    }

    function celulaAtiva(lider) {
        return !!lider && ehAtivo(lider.celula_ativa);
    }

    // Líder da célula a que a pessoa pertence: ela mesma (se for líder), o
    // líder associado (multiplicador) ou null (sem célula, ex.: fiscalização).
    function liderDaPessoa(p, pessoal) {
        if (!p) return null;
        if (p.funcao === 'lider') return p;
        if (p.lider_id == null) return null;
        return (pessoal || []).find(x => x.id == p.lider_id) || null;
    }

    // A pessoa está fora da Agenda por inatividade dela mesma ou da célula
    // (líder inativo ou célula do líder inativa).
    function pessoaInativaParaAgenda(p, pessoal) {
        if (!pessoaAtiva(p)) return true;
        const lider = liderDaPessoa(p, pessoal);
        if (!lider) return false;
        return !pessoaAtiva(lider) || !celulaAtiva(lider);
    }

    // Um veículo (cedido pelo líder lider) sai da Agenda quando o líder ou a
    // célula dele estão inativos.
    function veiculoInativoParaAgenda(lider, pessoal) {
        if (!lider) return false;
        return pessoaInativaParaAgenda(lider, pessoal);
    }

    // Multiplicadores ATIVOS do líder — só eles contam para a célula estar
    // completa.
    function multiplicadoresAtivosDoLider(liderId, pessoal) {
        return (pessoal || []).filter(p => p.lider_id === liderId && pessoaAtiva(p));
    }

    // Células completas (líder ativo + celula_ativa + minMultiplicadores
    // multiplicadores ATIVOS) e, dentre elas, as com carro (ao menos um veículo
    // com lider_id = líder). Devolve { completas: Set<liderId>, comCarro: Set<liderId> }.
    // Mesmo critério dos filtros 'completas' / 'completas_veiculo' das etiquetas.
    function celulasCompletas(pessoal, veiculos, opts) {
        const { minMultiplicadores = 4 } = opts || {};
        const lista = pessoal || [];
        const liderComVeiculo = new Set((veiculos || []).filter(v => v.lider_id != null).map(v => v.lider_id));
        const multsAtivas = new Map();
        lista.forEach(p => {
            if (p.funcao === 'multiplicador' && p.lider_id != null && pessoaAtiva(p)) {
                multsAtivas.set(p.lider_id, (multsAtivas.get(p.lider_id) || 0) + 1);
            }
        });
        const completas = new Set();
        const comCarro = new Set();
        lista.forEach(p => {
            if (p.funcao !== 'lider' || !pessoaAtiva(p) || !celulaAtiva(p)) return;
            if ((multsAtivas.get(p.id) || 0) < minMultiplicadores) return;
            completas.add(p.id);
            if (liderComVeiculo.has(p.id)) comCarro.add(p.id);
        });
        return { completas, comCarro };
    }

    // Contador da Gestão de Líderes: das células ATIVAS (líder com celula_ativa,
    // Comitê fora) quantas estão completas (líder ativo + minMultiplicadores
    // multiplicadores ATIVOS), quantas dessas completas têm carro (ao menos
    // um veículo com lider_id = líder — mesmo critério do filtro
    // 'completas_veiculo' das etiquetas) e quantas estão incompletas.
    // completasComCarro ⊆ completas; completas + incompletas = ativas.
    function resumoCelulasAtivas(pessoal, veiculos, opts) {
        const { minMultiplicadores = 4 } = opts || {};
        const lista = pessoal || [];
        const liderComVeiculo = new Set((veiculos || []).filter(v => v.lider_id != null).map(v => v.lider_id));
        const multsAtivas = new Map();
        lista.forEach(p => {
            if (p.funcao === 'multiplicador' && p.lider_id != null && pessoaAtiva(p)) {
                multsAtivas.set(p.lider_id, (multsAtivas.get(p.lider_id) || 0) + 1);
            }
        });
        let ativas = 0, completas = 0, completasComCarro = 0;
        lista.forEach(p => {
            if (p.funcao !== 'lider' || p.local_prestacao === 'Comitê' || !celulaAtiva(p)) return;
            ativas++;
            if (!pessoaAtiva(p) || (multsAtivas.get(p.id) || 0) < minMultiplicadores) return;
            completas++;
            if (liderComVeiculo.has(p.id)) completasComCarro++;
        });
        return { ativas, completas, completasComCarro, incompletas: ativas - completas };
    }

    // Histórico de atividade (tabela celula_atividade_historico): eventos da
    // célula do líder, do mais recente para o mais antigo. Empate de horário
    // (mesmo segundo) desempata pelo id maior = mais novo.
    function historicoDaCelula(historico, liderId) {
        return (historico || [])
            .filter(h => h.lider_id === liderId)
            .sort((a, b) => (Date.parse(b.created_at) - Date.parse(a.created_at)) || ((b.id || 0) - (a.id || 0)));
    }

    // Último evento de um alvo ('celula' ou 'pessoa'); para 'pessoa', só os
    // da pessoaId informada. null quando nunca mudou.
    function ultimoEvento(historicoDaCelulaOrdenado, alvo, pessoaId) {
        return (historicoDaCelulaOrdenado || []).find(h =>
            h.alvo === alvo && (alvo !== 'pessoa' || h.pessoa_id === pessoaId)) || null;
    }

    return {
        pessoaAtiva, celulaAtiva, liderDaPessoa,
        pessoaInativaParaAgenda, veiculoInativoParaAgenda, multiplicadoresAtivosDoLider,
        resumoCelulasAtivas, celulasCompletas, historicoDaCelula, ultimoEvento
    };
});
