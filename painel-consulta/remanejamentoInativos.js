// Sub-tela "Inativos" da Gestão de Líderes: quem está inativo (pessoa ou
// célula), os veículos associados a essas pessoas e as regras para
// REMANEJAR para outra célula sem perder o histórico de pagamento.
//
// O histórico de pagamento vive nos lançamentos, amarrado à PESSOA
// (pessoa_id / detalhe_pagamentos) e ao VEÍCULO (placa) — nunca à célula.
// Inativar ou remanejar só troca lider_id/ativo; por isso a parcela já paga
// continua paga na célula nova e a Agenda não cobra de novo (o n-ésimo
// pagamento quita a n-ésima parcela — ver lib/parcelasPessoal.js). Aqui só
// se monta a visão desse histórico e o que muda no cadastro ao remanejar.
//
// A 2ª fonte de "já foi pago" são as etiquetas impressas
// (etiquetas_pagamento_impressas): parte dos pagamentos da Parcela 1 só
// existe como etiqueta, sem lançamento por pessoa. Etiqueta sem lançamento
// correspondente vira AVISO (não dá pra saber se foi paga) — nunca é ignorada.
//
// UMD: usado pelo app.js (window.RemanejamentoInativos) e pelos testes.
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./atividadeCelula'), require('./parcelasPessoal'));
    else root.RemanejamentoInativos = factory(root.AtividadeCelula, root.ParcelasPessoal);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (AC, PP) {
    'use strict';

    const LOCAL_COMITE = 'Comitê';
    const MIN_MULTIPLICADORES_CELULA_COMPLETA = 4;

    const digitos = v => String(v == null ? '' : v).replace(/\D/g, '');
    const porNome = (a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR');

    // Veículos "da pessoa": os cedidos por ela (lider_id = ela, quando é
    // líder) e os que ela é proprietária pelo CPF e ainda não estão na célula
    // de outro líder.
    function veiculosDaPessoa(pessoa, veiculos) {
        const cpf = digitos(pessoa.cpf);
        return (veiculos || []).filter(v => {
            if (v.lider_id != null) return v.lider_id == pessoa.id; // eslint-disable-line eqeqeq
            return cpf.length === 11 && digitos(v.cpf_proprietario) === cpf;
        });
    }

    // Todo mundo que está fora da Agenda por inatividade — a pessoa
    // (ativo=false) ou a célula dela (celula_ativa=false) —, com os veículos
    // associados. `motivo`: 'pessoa' (inativada) ou 'celula' (célula
    // inativa). Líder não é remanejável (ele É a célula); seus veículos, sim.
    function listarInativos(pessoal, veiculos) {
        const lista = pessoal || [];
        return lista
            .filter(p => AC.pessoaInativaParaAgenda(p, lista))
            .sort(porNome)
            .map(p => ({
                pessoa: p,
                motivo: AC.pessoaAtiva(p) ? 'celula' : 'pessoa',
                remanejavel: p.funcao !== 'lider',
                liderOrigem: AC.liderDaPessoa(p, lista),
                veiculos: veiculosDaPessoa(p, veiculos).sort((a, b) => String(a.placa).localeCompare(String(b.placa), 'pt-BR'))
            }));
    }

    // Histórico de pagamento da pessoa: lançamentos (individuais e dentro de
    // consolidados) + etiquetas impressas. Devolve também o cronograma com o
    // flag `paga` por parcela (mesmo critério da Agenda) e as etiquetas que
    // NÃO têm lançamento correspondente (aviso de conferência).
    // Mesma visão a partir de uma CONTAGEM de pagamentos (o Painel de
    // Consulta não lê lançamentos: a RPC gestao_lideres_pagamentos_realizados
    // só devolve quantos pagamentos cada pessoa/placa recebeu). Sem datas.
    function historicoPessoaPorContagem(pessoa, pagas, etiquetas, pagamentos) {
        const cronograma = PP.calcularCronogramaParcelasPessoal(pessoa).map(c => ({ ...c, paga: c.parcela <= pagas }));
        const minhasEtiquetas = (etiquetas || [])
            .filter(e => e.pessoa_id != null && e.pessoa_id == pessoa.id) // eslint-disable-line eqeqeq
            .sort((a, b) => String(a.data_pagamento).localeCompare(String(b.data_pagamento)));
        return {
            pagamentos: pagamentos || [], pagas, cronograma,
            etiquetas: minhasEtiquetas,
            etiquetasSemLancamento: minhasEtiquetas.slice(pagas)
        };
    }

    function historicoVeiculoPorContagem(veiculo, lider, pagas, pagamentos) {
        const cronograma = PP.calcularCronogramaParcelasVeiculo(veiculo, lider).map(c => ({ ...c, paga: c.parcela <= pagas }));
        return { pagamentos: pagamentos || [], pagas, cronograma };
    }

    function historicoPessoa(pessoa, lancamentos, etiquetas) {
        const pagamentos = PP.pagamentosDaPessoa(pessoa, lancamentos);
        return historicoPessoaPorContagem(pessoa, pagamentos.length, etiquetas, pagamentos);
    }

    function historicoVeiculo(veiculo, lider, lancamentos) {
        const pagamentos = PP.pagamentosDoVeiculo(veiculo, lancamentos);
        return historicoVeiculoPorContagem(veiculo, lider, pagamentos.length, pagamentos);
    }

    // Líderes que podem receber alguém: ativos, célula ativa e fora do Comitê
    // (o Comitê é pago em bloco, sem controle por pessoa).
    function destinosPossiveis(pessoal) {
        const lista = pessoal || [];
        return lista
            .filter(p => p.funcao === 'lider' && AC.pessoaAtiva(p) && AC.celulaAtiva(p) && p.local_prestacao !== LOCAL_COMITE)
            .sort(porNome);
    }

    // Confere um remanejamento. `veiculosLevados`: veículos que vão junto (ou
    // sozinhos, quando a pessoa é líder). → { erros: [], avisos: [] }
    function validarRemanejamento({ pessoa, liderDestino, veiculosLevados, pessoal, veiculos }) {
        const erros = [];
        const avisos = [];
        const levados = veiculosLevados || [];
        const lista = pessoal || [];

        if (!liderDestino) {
            erros.push('Escolha a célula (líder) de destino.');
            return { erros, avisos };
        }
        if (liderDestino.funcao !== 'lider') erros.push('O destino precisa ser um líder.');
        if (!AC.pessoaAtiva(liderDestino) || !AC.celulaAtiva(liderDestino)) erros.push('A célula de destino está inativa.');
        if (liderDestino.local_prestacao === LOCAL_COMITE) erros.push('O Comitê é pago em bloco — não recebe remanejamento.');
        if (pessoa && pessoa.funcao === 'lider' && !levados.length) erros.push('Líder não é remanejado; só o veículo dele pode ir para outra célula.');
        if (pessoa && pessoa.id == liderDestino.id) erros.push('A pessoa não pode ser remanejada para a própria célula.'); // eslint-disable-line eqeqeq

        if (levados.length > 1) erros.push('Um líder cede só um veículo — leve um veículo por vez.');
        if (levados.length) {
            const jaTem = (veiculos || []).find(v => v.lider_id == liderDestino.id && !levados.some(l => l.id === v.id)); // eslint-disable-line eqeqeq
            if (jaTem) erros.push(`O líder de destino já tem um veículo associado (${jaTem.placa}). Um líder só pode ceder um veículo.`);
        }

        if (pessoa && pessoa.funcao !== 'lider') {
            const ativosNoDestino = AC.multiplicadoresAtivosDoLider(liderDestino.id, lista).length;
            if (ativosNoDestino >= MIN_MULTIPLICADORES_CELULA_COMPLETA) {
                avisos.push(`A célula de ${liderDestino.nome} já tem ${ativosNoDestino} multiplicadores ativos (célula completa).`);
            }
        }
        return { erros, avisos };
    }

    // O que muda no cadastro da pessoa ao ser remanejada: passa para o líder
    // de destino, volta a ficar ativa e herda localidade/coordenador da nova
    // célula (a Agenda, as etiquetas e as regiões agrupam pela célula).
    function payloadPessoaRemanejada(pessoa, liderDestino) {
        return {
            lider_id: liderDestino.id,
            ativo: true,
            local_prestacao: liderDestino.local_prestacao || pessoa.local_prestacao || null,
            coordenador: liderDestino.coordenador || pessoa.coordenador || null
        };
    }

    // Veículo na célula nova: mesmas regras do cadastro de Veículos (o líder é
    // o proprietário — nome/CPF/localidade vêm do cadastro dele).
    function payloadVeiculoRemanejado(veiculo, liderDestino) {
        return {
            lider_id: liderDestino.id,
            nome_proprietario: liderDestino.nome || null,
            cpf_proprietario: liderDestino.cpf || null,
            localidade_atendimento: liderDestino.local_prestacao || veiculo.localidade_atendimento || null
        };
    }

    return {
        veiculosDaPessoa, listarInativos, historicoPessoa, historicoVeiculo,
        historicoPessoaPorContagem, historicoVeiculoPorContagem,
        destinosPossiveis, validarRemanejamento, payloadPessoaRemanejada, payloadVeiculoRemanejado
    };
});
