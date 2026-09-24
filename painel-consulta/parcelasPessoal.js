// Projeção de parcelas de pagamento de uma pessoa do quadro (Pessoal).
// Lógica pura, sem acesso a appData — recebe a pessoa e a lista de
// lançamentos por parâmetro.
//
// Modelo (o mesmo que a Agenda de Pagamento já usa):
//   - modo 'fixo': duas datas de calendário fixas (PARCELAS_FIXAS_PESSOAL),
//     valor do contrato dividido em dois (sem sobra de centavo);
//   - modo 'semanal'/'quinzenal': parcelas de data_inicio + N*intervalo
//     até data_fim, valor do contrato dividido igualmente;
//   - "parcela paga" = um lançamento DESPESA com pessoa_id da pessoa
//     (consumo em ordem: o n-ésimo lançamento quita a n-ésima parcela).
//
// UMD: usado pelo app.js do admin (window.ParcelasPessoal) e pelo
// servidor (snapshot do formulário público de pagamento, Parte C).
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.ParcelasPessoal = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Duas parcelas em datas fixas de calendário — opção padrão de
    // pagamento de Pessoal, independente de data de início/fim do contrato.
    const PARCELAS_FIXAS_PESSOAL = ['2026-09-17', '2026-10-02'];

    // Tipificações dos lançamentos de aluguel de veículo. "Aluguel de
    // Veículos" = veículo com CNPJ associado da própria campanha (conta pro
    // sublimite legal); "Aluguel de Carros" = qualquer outro veículo cedido
    // por líder (não conta pro sublimite — ver adicionarVeiculosNaAgenda em
    // app.js). Pra fins de "parcela paga"/progressão de cronograma as duas
    // são a mesma coisa: o que importa é a placa, não qual das duas rotula
    // o lançamento.
    const TIPIFICACOES_VEICULO = new Set(['Aluguel de Veículos', 'Aluguel de Carros']);

    function intervaloDiasPeriodicidade(periodicidade) {
        if (periodicidade === 'semanal') return 7;
        if (periodicidade === 'quinzenal') return 15;
        return null;
    }

    // Datas do modo 'personalizado': lista de 'YYYY-MM-DD' definida pessoa a
    // pessoa no cadastro. Aceita array ou string JSON (o jsonb pode voltar
    // como um ou outro conforme a fonte). Descarta valores inválidos,
    // remove duplicadas e devolve em ordem cronológica.
    function normalizarDatasPersonalizadas(valor) {
        let lista = valor;
        if (typeof lista === 'string') {
            try { lista = JSON.parse(lista); } catch (e) { lista = lista.split(','); }
        }
        if (!Array.isArray(lista)) return [];
        const limpas = lista
            .map(d => String(d == null ? '' : d).trim().slice(0, 10))
            .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
        return [...new Set(limpas)].sort();
    }

    // Divide um total em N parcelas de centavo exato — a última absorve a
    // sobra da divisão, para a soma bater com o total ao centavo.
    function dividirValorParcelas(total, quantidade) {
        const centavosTotal = Math.round(Number(total) * 100);
        const base = Math.floor(centavosTotal / quantidade);
        const resto = centavosTotal - (base * quantidade);
        const valores = [];
        for (let i = 0; i < quantidade; i++) {
            valores.push((base + (i === quantidade - 1 ? resto : 0)) / 100);
        }
        return valores;
    }

    // Normaliza a coluna detalhe_pagamentos (jsonb): aceita array ou string
    // JSON (o driver pode devolver um ou outro) e devolve sempre um array.
    function normalizarDetalhePagamentos(valor) {
        let lista = valor;
        if (typeof lista === 'string') {
            try { lista = JSON.parse(lista); } catch (e) { return []; }
        }
        return Array.isArray(lista) ? lista : [];
    }

    // Pagamentos efetivos de UMA pessoa a partir da lista de lançamentos —
    // devolve [{ valor, data, parcela? }]. Expande os lançamentos
    // consolidados da Agenda (detalhe_pagamentos) e mantém os lançamentos
    // individuais legados (pessoa_id direto). Um lançamento consolidado tem
    // pessoa_id nulo; um legado não tem detalhe_pagamentos — sem risco de
    // contar em dobro. (== proposital: ids podem vir number ou string.)
    function pagamentosDaPessoa(pessoa, lancamentos) {
        const saidas = [];
        (lancamentos || []).forEach(l => {
            if (l.tipo !== 'DESPESA') return;
            if (l.pessoa_id != null && l.pessoa_id == pessoa.id) { // eslint-disable-line eqeqeq
                saidas.push({ valor: Number(l.valor) || 0, data: l.data });
                return;
            }
            normalizarDetalhePagamentos(l.detalhe_pagamentos).forEach(d => {
                if (d && d.pessoa_id != null && d.pessoa_id == pessoa.id) { // eslint-disable-line eqeqeq
                    saidas.push({ valor: Number(d.valor) || 0, data: l.data, parcela: d.parcela });
                }
            });
        });
        return saidas;
    }

    // Pagamentos efetivos de UM veículo (por placa, tipificação de aluguel
    // de veículos) — mesmo modelo de pagamentosDaPessoa.
    function pagamentosDoVeiculo(veiculo, lancamentos) {
        const placa = veiculo && veiculo.placa;
        const saidas = [];
        (lancamentos || []).forEach(l => {
            if (l.tipo !== 'DESPESA' || !TIPIFICACOES_VEICULO.has(l.tipificacao)) return;
            if (l.placa != null && l.placa === placa) {
                saidas.push({ valor: Number(l.valor) || 0, data: l.data });
                return;
            }
            normalizarDetalhePagamentos(l.detalhe_pagamentos).forEach(d => {
                if (d && d.placa != null && d.placa === placa) {
                    saidas.push({ valor: Number(d.valor) || 0, data: l.data, parcela: d.parcela });
                }
            });
        });
        return saidas;
    }

    // Nº de parcelas já quitadas de uma pessoa (consumo em ordem).
    function contarParcelasPagas(pessoa, lancamentos) {
        return pagamentosDaPessoa(pessoa, lancamentos).length;
    }

    // Só as DATAS do cronograma da pessoa (sem valor), na ordem cronológica —
    // 'fixo' usa as duas datas fixas; 'personalizado' as datas cadastradas;
    // 'semanal'/'quinzenal' projeta de data_inicio + N*intervalo até data_fim
    // (a primeira parcela vence ao fim do primeiro período, não no dia de
    // início). Vazio quando não dá para projetar. Serve tanto para o
    // cronograma de Pessoal quanto para o de um veículo que segue o líder.
    function datasCronogramaPessoal(pessoa) {
        if (!pessoa) return [];

        if (pessoa.periodicidade_pagamento === 'fixo') return PARCELAS_FIXAS_PESSOAL.slice();

        if (pessoa.periodicidade_pagamento === 'personalizado') {
            return normalizarDatasPersonalizadas(pessoa.datas_pagamento_personalizadas);
        }

        const dias = intervaloDiasPeriodicidade(pessoa.periodicidade_pagamento);
        if (!dias || !pessoa.data_inicio || !pessoa.data_fim) return [];

        const inicio = new Date(pessoa.data_inicio + 'T00:00:00');
        const fim = new Date(pessoa.data_fim + 'T00:00:00');
        if (isNaN(inicio) || isNaN(fim) || fim < inicio) return [];

        const datas = [];
        const cursor = new Date(inicio);
        cursor.setDate(cursor.getDate() + dias);
        while (cursor <= fim && datas.length < 500) {
            datas.push(cursor.toISOString().slice(0, 10));
            cursor.setDate(cursor.getDate() + dias);
        }
        return datas;
    }

    // Distribui um total pelas datas dadas — parcelas de centavo exato,
    // sobra na última. [{ data, parcela, totalParcelas, valor }].
    function cronogramaDeDatas(datas, total) {
        if (!datas.length || !total) return [];
        const valores = dividirValorParcelas(Number(total), datas.length);
        return datas.map((data, i) => ({
            data, parcela: i + 1, totalParcelas: datas.length, valor: valores[i]
        }));
    }

    // Cronograma COMPLETO da pessoa: todas as parcelas, pagas ou não.
    // [{ data: 'YYYY-MM-DD', parcela, totalParcelas, valor }] — vazio
    // quando não dá para projetar (sem valor de contrato, sem periodicidade,
    // datas inválidas).
    function calcularCronogramaParcelasPessoal(pessoa) {
        if (!pessoa || !pessoa.valor_contrato) return [];
        return cronogramaDeDatas(datasCronogramaPessoal(pessoa), pessoa.valor_contrato);
    }

    // ── Veículos associados a um líder ──────────────────────────────────
    // O veículo cedido por um líder é pago no MESMO cronograma do contrato
    // do líder (mesmas datas / mesmo nº de parcelas), mas com o valor
    // contratado do próprio veículo dividido nessas parcelas. "Parcela paga"
    // = pagamento DESPESA / tipificação 'Aluguel de Veículos' com a placa do
    // veículo (individual ou dentro de detalhe_pagamentos), consumo em ordem.
    function contarParcelasPagasVeiculo(veiculo, lancamentos) {
        return pagamentosDoVeiculo(veiculo, lancamentos).length;
    }

    function calcularCronogramaParcelasVeiculo(veiculo, lider) {
        if (!veiculo || !veiculo.valor_contratado || !lider) return [];
        return cronogramaDeDatas(datasCronogramaPessoal(lider), veiculo.valor_contratado);
    }

    function parcelasFuturasVeiculo(veiculo, lider, lancamentos) {
        const pagas = contarParcelasPagasVeiculo(veiculo, lancamentos);
        return calcularCronogramaParcelasVeiculo(veiculo, lider).filter(p => p.parcela > pagas);
    }

    // Só as parcelas que ainda faltam lançar (índice > parcelas pagas).
    // Mesmo resultado de app.js#calcularParcelasFuturasPessoal.
    function parcelasFuturasPessoal(pessoa, lancamentos) {
        const pagas = contarParcelasPagas(pessoa, lancamentos);
        return calcularCronogramaParcelasPessoal(pessoa).filter(p => p.parcela > pagas);
    }

    // A próxima parcela a vencer (ou null se está tudo quitado).
    function proximoPagamentoPessoal(pessoa, lancamentos) {
        const futuras = parcelasFuturasPessoal(pessoa, lancamentos);
        return futuras.length ? futuras[0] : null;
    }

    return {
        PARCELAS_FIXAS_PESSOAL,
        TIPIFICACOES_VEICULO,
        intervaloDiasPeriodicidade,
        normalizarDatasPersonalizadas,
        normalizarDetalhePagamentos,
        dividirValorParcelas,
        datasCronogramaPessoal,
        pagamentosDaPessoa,
        pagamentosDoVeiculo,
        contarParcelasPagas,
        calcularCronogramaParcelasPessoal,
        parcelasFuturasPessoal,
        proximoPagamentoPessoal,
        contarParcelasPagasVeiculo,
        calcularCronogramaParcelasVeiculo,
        parcelasFuturasVeiculo
    };
});
